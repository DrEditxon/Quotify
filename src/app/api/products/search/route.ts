import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { mockDB, isMockMode } from '@/lib/mockDb';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get('query');

    if (!query) {
      return NextResponse.json({ products: [] });
    }

    // --- MOCK MODE ---
    if (isMockMode()) {
      const lowerQuery = query.toLowerCase();
      const filtered = mockDB.products
        .filter(
          (p) =>
            p.code.toLowerCase().includes(lowerQuery) ||
            p.description.toLowerCase().includes(lowerQuery)
        )
        .slice(0, 15)
        .map((p) => ({
          id: p.id,
          code: p.code,
          description: p.description,
          presentation: p.presentation,
          manufacturer: p.manufacturer,
          unit_price: p.unit_price,
          iva: p.iva,
        }));

      return NextResponse.json({ products: filtered });
    }

    // --- PRODUCCIÓN: Supabase ---
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, code, description, presentation, manufacturer, unit_price, iva')
      .or(`code.ilike.%${query}%,description.ilike.%${query}%`)
      .limit(15);

    if (error) {
      console.error('Error al buscar productos:', error);
      return NextResponse.json({ error: 'No se pudo buscar productos.', details: error.message }, { status: 500 });
    }

    return NextResponse.json({ products: data || [] });
  } catch (error: any) {
    console.error('Error en /api/products/search:', error);
    return NextResponse.json({ error: 'Error interno del servidor', details: error.message }, { status: 500 });
  }
}
