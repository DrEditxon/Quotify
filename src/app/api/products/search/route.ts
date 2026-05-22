import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get('query');

    if (!query) {
      return NextResponse.json({ products: [] });
    }

    // Buscar por código o descripción usando ILIKE (coincidencia parcial insensible a mayúsculas/minúsculas)
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
