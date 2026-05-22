// Simulación de Base de Datos para el modo Demo/Prueba
export interface MockProduct {
  id: string;
  code: string;
  description: string;
  presentation: string;
  manufacturer: string;
  iva: number;
  unit_price: number;
}

export interface MockStock {
  product_code: string;
  lot: string;
  quantity: number;
}

export interface MockAlias {
  client_article_name: string;
  product_id: string;
}

interface MockDB {
  products: MockProduct[];
  stocks: MockStock[];
  aliases: MockAlias[];
}

const globalRef = global as any;
if (!globalRef.mockDB) {
  globalRef.mockDB = {
    products: [],
    stocks: [],
    aliases: []
  };
}

export const mockDB: MockDB = globalRef.mockDB;

// Determinar si la aplicación está en modo de prueba/demo sin base de datos real
export function isMockMode(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  return !url || url.includes('your-supabase-project') || !key || key.includes('your-anon');
}

// Algoritmo de Similitud Trigrámica en JavaScript (Jaccard de Trigramas)
// Hace exactamente el mismo cálculo que pg_trgm en Postgres
export function calculateTrigramSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;

  const getTrigrams = (str: string): string[] => {
    const clean = '  ' + str.toLowerCase() + '  ';
    const trigrams = [];
    for (let i = 0; i < clean.length - 2; i++) {
      trigrams.push(clean.substring(i, i + 3));
    }
    return trigrams;
  };

  const trigrams1 = getTrigrams(str1);
  const trigrams2 = getTrigrams(str2);
  
  if (trigrams1.length === 0 || trigrams2.length === 0) return 0;

  const set1 = new Set(trigrams1);
  const set2 = new Set(trigrams2);
  
  let intersection = 0;
  set1.forEach(t => {
    if (set2.has(t)) {
      intersection++;
    }
  });
  
  const union = new Set([...trigrams1, ...trigrams2]).size;
  return union === 0 ? 0 : intersection / union;
}
