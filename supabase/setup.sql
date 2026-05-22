-- 1. Habilitar la extensión de búsqueda difusa (Trigramas)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Tabla de Productos (Catálogo Maestro)
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    presentation TEXT,
    manufacturer TEXT,
    iva NUMERIC(5,2) DEFAULT 0.00,
    unit_price NUMERIC(12,2) DEFAULT 0.00,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Índices para Products
CREATE INDEX IF NOT EXISTS idx_products_description_trgm ON products USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_code ON products (code);

-- 3. Tabla de Stock por Lote (Físico)
CREATE TABLE IF NOT EXISTS product_stocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    lot TEXT NOT NULL,
    quantity NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Índice para búsquedas rápidas de stock
CREATE INDEX IF NOT EXISTS idx_product_stocks_product_id ON product_stocks (product_id);

-- 4. Tabla de Alias de Clientes (UI de Aprendizaje - Capa 1)
CREATE TABLE IF NOT EXISTS client_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_article_name TEXT NOT NULL UNIQUE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Índice para matching rápido por alias
CREATE INDEX IF NOT EXISTS idx_client_aliases_name ON client_aliases (client_article_name);


-- 5. RPC: match_client_product (Motor de Matching de 3 Capas)
CREATE OR REPLACE FUNCTION match_client_product(p_search_term TEXT)
RETURNS TABLE (
    product_id UUID,
    code TEXT,
    description TEXT,
    presentation TEXT,
    manufacturer TEXT,
    iva NUMERIC,
    unit_price NUMERIC,
    total_stock NUMERIC,
    lots JSONB,
    match_type TEXT,
    similarity_score DOUBLE PRECISION
) AS $$
DECLARE
    v_product_id UUID := NULL;
    v_match_type TEXT := 'none';
    v_similarity DOUBLE PRECISION := 0.0;
BEGIN
    p_search_term := trim(p_search_term);

    -- Capa 1: Match exacto por Alias de cliente
    SELECT a.product_id INTO v_product_id
    FROM client_aliases a
    WHERE lower(a.client_article_name) = lower(p_search_term)
    LIMIT 1;

    IF v_product_id IS NOT NULL THEN
        v_match_type := 'exact_alias';
        v_similarity := 1.0;
    END IF;

    -- Capa 1 (Continuación): Match exacto en Catálogo (Código o Descripción)
    IF v_product_id IS NULL THEN
        SELECT p.id INTO v_product_id
        FROM products p
        WHERE lower(p.code) = lower(p_search_term) 
           OR lower(p.description) = lower(p_search_term)
        LIMIT 1;

        IF v_product_id IS NOT NULL THEN
            v_match_type := 'exact_product';
            v_similarity := 1.0;
        END IF;
    END IF;

    -- Capa 2: Match difuso usando pg_trgm (Búsqueda trigrámica)
    IF v_product_id IS NULL THEN
        SELECT p.id, similarity(p.description, p_search_term) INTO v_product_id, v_similarity
        FROM products p
        WHERE similarity(p.description, p_search_term) > 0.30
        ORDER BY similarity(p.description, p_search_term) DESC
        LIMIT 1;

        IF v_product_id IS NOT NULL THEN
            v_match_type := 'trigram';
        END IF;
    END IF;

    -- Retorno consolidado de datos y stock por lotes
    IF v_product_id IS NOT NULL THEN
        RETURN QUERY
        SELECT 
            p.id AS product_id,
            p.code,
            p.description,
            p.presentation,
            p.manufacturer,
            p.iva,
            p.unit_price,
            COALESCE(SUM(s.quantity), 0) AS total_stock,
            COALESCE(
                jsonb_agg(
                    jsonb_build_object('lot', s.lot, 'quantity', s.quantity)
                ) FILTER (WHERE s.lot IS NOT NULL AND s.quantity > 0), 
                '[]'::jsonb
            ) AS lots,
            v_match_type AS match_type,
            v_similarity AS similarity_score
        FROM products p
        LEFT JOIN product_stocks s ON p.id = s.product_id
        WHERE p.id = v_product_id
        GROUP BY p.id;
    ELSE
        -- Retornar fila vacía en caso de no encontrar coincidencia
        RETURN QUERY
        SELECT 
            NULL::UUID AS product_id,
            NULL::TEXT AS code,
            NULL::TEXT AS description,
            NULL::TEXT AS presentation,
            NULL::TEXT AS manufacturer,
            NULL::NUMERIC AS iva,
            NULL::NUMERIC AS unit_price,
            0.00::NUMERIC AS total_stock,
            '[]'::jsonb AS lots,
            'none'::TEXT AS match_type,
            0.0::DOUBLE PRECISION AS similarity_score;
    END IF;
END;
$$ LANGUAGE plpgsql;


-- 6. RPC: sync_inventory (Sincronización Atómica de Inventario)
CREATE OR REPLACE FUNCTION sync_inventory(
    p_products JSONB, -- Formato: [{code, description, presentation, manufacturer, iva, unit_price}]
    p_stocks JSONB    -- Formato: [{product_code, lot, quantity}]
) RETURNS VOID AS $$
DECLARE
    prod RECORD;
    stk RECORD;
BEGIN
    -- 1. Upsert al catálogo maestro de productos (evitando duplicar códigos)
    FOR prod IN SELECT * FROM jsonb_to_recordset(p_products) 
        AS x(code TEXT, description TEXT, presentation TEXT, manufacturer TEXT, iva NUMERIC, unit_price NUMERIC) 
    LOOP
        INSERT INTO products (code, description, presentation, manufacturer, iva, unit_price, updated_at)
        VALUES (prod.code, prod.description, prod.presentation, prod.manufacturer, prod.iva, prod.unit_price, now())
        ON CONFLICT (code) DO UPDATE 
        SET description = EXCLUDED.description,
            presentation = EXCLUDED.presentation,
            manufacturer = EXCLUDED.manufacturer,
            iva = EXCLUDED.iva,
            unit_price = EXCLUDED.unit_price,
            updated_at = now();
    END LOOP;

    -- 2. Limpieza total de existencias (reemplazo completo diario)
    DELETE FROM product_stocks;

    -- 3. Inserción de las nuevas existencias vinculadas por código
    FOR stk IN SELECT * FROM jsonb_to_recordset(p_stocks) 
        AS x(product_code TEXT, lot TEXT, quantity NUMERIC) 
    LOOP
        INSERT INTO product_stocks (product_id, lot, quantity)
        SELECT id, stk.lot, stk.quantity
        FROM products
        WHERE code = stk.product_code;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
