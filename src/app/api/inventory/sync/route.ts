import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const { products, stocks } = await req.json();

    if (!products || !stocks || !Array.isArray(products) || !Array.isArray(stocks)) {
      return NextResponse.json(
        { error: 'Parámetros inválidos. Se requieren arreglos de "products" y "stocks".' },
        { status: 400 }
      );
    }

    const { mockDB, isMockMode } = require('@/lib/mockDb');

    if (isMockMode()) {
      console.log('--- MOCK MODE ACTIVE: Sincronizando Inventario en Memoria ---');
      mockDB.products = products.map((p: any) => ({
        id: p.id || crypto.randomUUID(),
        code: String(p.code),
        description: String(p.description),
        presentation: String(p.presentation || ''),
        manufacturer: String(p.manufacturer || ''),
        iva: Number(p.iva || 0),
        unit_price: Number(p.unit_price || 0)
      }));

      mockDB.stocks = stocks.map((s: any) => ({
        product_code: String(s.product_code),
        lot: String(s.lot),
        quantity: Number(s.quantity || 0)
      }));

      return NextResponse.json({ success: true, message: 'Inventario sincronizado de forma atómica en memoria (MODO DEMO).' });
    }

    const { error } = await supabaseAdmin.rpc('sync_inventory', {
      p_products: products,
      p_stocks: stocks,
    });

    if (error) {
      console.error('Error al sincronizar el inventario mediante RPC:', error);
      return NextResponse.json({ error: 'No se pudo sincronizar el inventario.', details: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Inventario sincronizado de forma atómica con éxito.' });
  } catch (error: any) {
    console.error('Error en /api/inventory/sync:', error);
    return NextResponse.json({ error: 'Error interno del servidor', details: error.message }, { status: 500 });
  }
}
