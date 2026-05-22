import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { mockDB, isMockMode, calculateTrigramSimilarity } from '@/lib/mockDb';

interface MatchRequestItem {
  name: string;
  quantity: number;
}

const CHUNK_SIZE = 25;
const DELAY_BETWEEN_CHUNKS_MS = 50;

// Motor de matching de 3 capas ejecutado en memoria (Modo Demo)
function mockMatchProduct(searchTerm: string, quantity: number) {
  const term = searchTerm.trim().toLowerCase();

  // Capa 1: Alias exacto
  const alias = mockDB.aliases.find(
    (a) => a.client_article_name.toLowerCase() === term
  );
  if (alias) {
    const product = mockDB.products.find((p) => p.id === alias.product_id);
    if (product) return buildMatchResult(searchTerm, quantity, product, 'exact_alias', 1.0);
  }

  // Capa 1 (cont.): Match exacto por código o descripción
  const exactProduct = mockDB.products.find(
    (p) => p.code.toLowerCase() === term || p.description.toLowerCase() === term
  );
  if (exactProduct) return buildMatchResult(searchTerm, quantity, exactProduct, 'exact_product', 1.0);

  // Capa 2: Match difuso por trigramas (umbral > 0.30)
  let bestMatch: typeof mockDB.products[0] | null = null;
  let bestScore = 0;

  for (const p of mockDB.products) {
    const score = calculateTrigramSimilarity(p.description, searchTerm);
    if (score > 0.30 && score > bestScore) {
      bestScore = score;
      bestMatch = p;
    }
  }

  if (bestMatch) return buildMatchResult(searchTerm, quantity, bestMatch, 'trigram', bestScore);

  // Sin coincidencia
  return createEmptyMatch({ name: searchTerm, quantity });
}

function buildMatchResult(
  clientName: string,
  clientQuantity: number,
  product: typeof mockDB.products[0],
  matchType: string,
  similarityScore: number
) {
  // Consolidar stock de todos los lotes para este producto
  const productStocks = mockDB.stocks.filter(
    (s) => s.product_code === product.code
  );
  const totalStock = productStocks.reduce((sum, s) => sum + s.quantity, 0);
  const lots = productStocks
    .filter((s) => s.quantity > 0)
    .map((s) => ({ lot: s.lot, quantity: s.quantity }));

  let confidence: 'high' | 'medium' | 'low' = 'low';
  if (matchType === 'exact_alias' || matchType === 'exact_product') {
    confidence = 'high';
  } else if (matchType === 'trigram') {
    if (similarityScore >= 0.70) confidence = 'high';
    else if (similarityScore >= 0.30) confidence = 'medium';
  }

  return {
    clientName,
    clientQuantity,
    matchedProduct: {
      productId: product.id,
      code: product.code,
      description: product.description,
      presentation: product.presentation,
      manufacturer: product.manufacturer,
      iva: product.iva,
      unitPrice: product.unit_price,
      totalStock,
      lots,
    },
    matchType,
    similarityScore,
    confidence,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const items: MatchRequestItem[] = body.items;

    if (!items || !Array.isArray(items)) {
      return NextResponse.json({ error: 'El cuerpo de la solicitud debe contener un arreglo de items.' }, { status: 400 });
    }

    // --- MOCK MODE ---
    if (isMockMode()) {
      console.log('--- MOCK MODE ACTIVE: Analizando matching en memoria ---');
      const results = items.map((item) => mockMatchProduct(item.name, item.quantity));
      return NextResponse.json({ results });
    }

    // --- PRODUCCIÓN: Supabase ---
    const results = [];

    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);

      const chunkPromises = chunk.map(async (item) => {
        try {
          const { data, error } = await supabaseAdmin.rpc('match_client_product', {
            p_search_term: item.name,
          });

          if (error) {
            console.error(`Error al buscar match para "${item.name}":`, error);
            return createEmptyMatch(item);
          }

          if (!data || data.length === 0 || !data[0].product_id) {
            return createEmptyMatch(item);
          }

          const match = data[0];

          let confidence: 'high' | 'medium' | 'low' = 'low';
          if (match.match_type === 'exact_alias' || match.match_type === 'exact_product') {
            confidence = 'high';
          } else if (match.match_type === 'trigram') {
            if (match.similarity_score >= 0.70) confidence = 'high';
            else if (match.similarity_score >= 0.30) confidence = 'medium';
          }

          return {
            clientName: item.name,
            clientQuantity: item.quantity,
            matchedProduct: {
              productId: match.product_id,
              code: match.code,
              description: match.description,
              presentation: match.presentation,
              manufacturer: match.manufacturer,
              iva: Number(match.iva || 0),
              unitPrice: Number(match.unit_price || 0),
              totalStock: Number(match.total_stock || 0),
              lots: match.lots || [],
            },
            matchType: match.match_type,
            similarityScore: match.similarity_score,
            confidence,
          };
        } catch (err) {
          console.error(`Excepción buscando match para "${item.name}":`, err);
          return createEmptyMatch(item);
        }
      });

      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);

      if (i + CHUNK_SIZE < items.length) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_CHUNKS_MS));
      }
    }

    return NextResponse.json({ results });
  } catch (error: any) {
    console.error('Error general en /api/matching/analyze:', error);
    return NextResponse.json({ error: 'Error interno del servidor', details: error.message }, { status: 500 });
  }
}

function createEmptyMatch(item: MatchRequestItem) {
  return {
    clientName: item.name,
    clientQuantity: item.quantity,
    matchedProduct: {
      productId: null,
      code: null,
      description: null,
      presentation: null,
      manufacturer: null,
      iva: 0,
      unitPrice: 0,
      totalStock: 0,
      lots: [],
    },
    matchType: 'none',
    similarityScore: 0,
    confidence: 'low' as const,
  };
}
