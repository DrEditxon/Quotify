import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

interface MatchRequestItem {
  name: string;
  quantity: number;
}

const CHUNK_SIZE = 25;
const DELAY_BETWEEN_CHUNKS_MS = 50;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const items: MatchRequestItem[] = body.items;

    if (!items || !Array.isArray(items)) {
      return NextResponse.json({ error: 'El cuerpo de la solicitud debe contener un arreglo de items.' }, { status: 400 });
    }

    const results = [];

    // Procesar los elementos por bloques (chunks) para optimizar el rendimiento de la DB y evitar timeouts
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

          // Determinar nivel de confianza
          let confidence: 'high' | 'medium' | 'low' = 'low';
          if (match.match_type === 'exact_alias' || match.match_type === 'exact_product') {
            confidence = 'high';
          } else if (match.match_type === 'trigram') {
            if (match.similarity_score >= 0.70) {
              confidence = 'high';
            } else if (match.similarity_score >= 0.30) {
              confidence = 'medium';
            }
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

      // Esperar brevemente entre bloques si hay más por procesar
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
