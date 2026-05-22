import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const { clientArticleName, productId } = await req.json();

    if (!clientArticleName || !productId) {
      return NextResponse.json(
        { error: 'Parámetros faltantes: se requiere clientArticleName y productId.' },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseAdmin
      .from('client_aliases')
      .upsert(
        {
          client_article_name: clientArticleName.trim(),
          product_id: productId,
        },
        { onConflict: 'client_article_name' }
      )
      .select();

    if (error) {
      console.error('Error al guardar el alias en client_aliases:', error);
      return NextResponse.json({ error: 'No se pudo guardar el alias.', details: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, alias: data[0] });
  } catch (error: any) {
    console.error('Error en /api/aliases/create:', error);
    return NextResponse.json({ error: 'Error interno del servidor', details: error.message }, { status: 500 });
  }
}
