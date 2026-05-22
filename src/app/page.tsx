'use client';

import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';

// Tipado de datos
interface LotStock {
  lot: string;
  quantity: number;
}

interface MatchedProduct {
  productId: string | null;
  code: string | null;
  description: string | null;
  presentation: string | null;
  manufacturer: string | null;
  iva: number;
  unitPrice: number;
  totalStock: number;
  lots: LotStock[];
}

interface QuoteItem {
  id: number;
  clientName: string;
  clientQuantity: number;
  matchedProduct: MatchedProduct;
  matchType: string;
  similarityScore: number;
  confidence: 'high' | 'medium' | 'low';
  isManualLink?: boolean;
}

interface ProductSearchResult {
  id: string;
  code: string;
  description: string;
  presentation: string;
  manufacturer: string;
  unit_price: number;
  iva: number;
}

export default function SmartQuoteDashboard() {
  // Estados de Inventario
  const [inventoryFile, setInventoryFile] = useState<File | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [syncStats, setSyncStats] = useState<{ products: number; stocks: number } | null>(null);
  const [syncErrorMessage, setSyncErrorMessage] = useState('');

  // Estados de Cotización
  const [quoteFile, setQuoteFile] = useState<File | null>(null);
  const [quoteItems, setQuoteItems] = useState<QuoteItem[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState('');

  // UI de Aprendizaje / Selección manual
  const [activeSearchId, setActiveSearchId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ProductSearchResult[]>([]);
  const [isSearchingProducts, setIsSearchingProducts] = useState(false);

  // Stats de la Cotización
  const [totals, setTotals] = useState({
    totalItems: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    stockAlertsCount: 0,
  });

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Normalizar nombres de columnas de Excel
  const normalizeKey = (key: string): string => {
    return key
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/__+/g, '_')
      .trim();
  };

  // Recalcular métricas cuando cambian los items procesados
  useEffect(() => {
    if (quoteItems.length === 0) {
      setTotals({ totalItems: 0, matchedCount: 0, unmatchedCount: 0, stockAlertsCount: 0 });
      return;
    }

    let matched = 0;
    let unmatched = 0;
    let stockAlerts = 0;

    quoteItems.forEach((item) => {
      const hasMatch = !!item.matchedProduct.productId;
      if (hasMatch) {
        matched++;
        if (item.matchedProduct.totalStock < item.clientQuantity) {
          stockAlerts++;
        }
      } else {
        unmatched++;
      }
    });

    setTotals({
      totalItems: quoteItems.length,
      matchedCount: matched,
      unmatchedCount: unmatched,
      stockAlertsCount: stockAlerts,
    });
  }, [quoteItems]);

  // Carga e Importación del Inventario Maestro
  const handleInventoryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setInventoryFile(file);
    setSyncStatus('loading');
    setSyncErrorMessage('');
    setSyncStats(null);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet);

        if (rows.length === 0) {
          throw new Error('El archivo de inventario está vacío.');
        }

        const productsMap = new Map<string, any>();
        const stocksList: any[] = [];

        rows.forEach((row: any) => {
          const normalized: any = {};
          Object.keys(row).forEach((k) => {
            normalized[normalizeKey(k)] = row[k];
          });

          // Buscar columnas mapeadas flexibles
          const code = String(normalized.codigo || normalized.code || '').trim();
          const description = String(normalized.descripcion || normalized.description || normalized.nombre || '').trim();
          const presentation = String(normalized.presentacion || normalized.presentation || '').trim();
          const manufacturer = String(normalized.fabricante || normalized.manufacturer || normalized.marca || '').trim();
          const iva = parseFloat(normalized.iva || '0');
          const unitPrice = parseFloat(normalized.precio_unitario || normalized.precio || normalized.price || '0');
          const lot = String(normalized.lote || normalized.lot || '').trim();
          const quantity = parseFloat(normalized.cant || normalized.cantidad || normalized.quantity || normalized.stock || '0');

          if (code && description) {
            productsMap.set(code, {
              code,
              description,
              presentation,
              manufacturer,
              iva,
              unit_price: unitPrice,
            });

            if (lot) {
              stocksList.push({
                product_code: code,
                lot,
                quantity,
              });
            }
          }
        });

        const productsList = Array.from(productsMap.values());

        if (productsList.length === 0) {
          throw new Error('No se encontraron productos válidos en el archivo. Verifique que existan las columnas "CODIGO" y "DESCRIPCIÓN".');
        }

        // Llamar a nuestra API de sincronización atómica
        const response = await fetch('/api/inventory/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            products: productsList,
            stocks: stocksList,
          }),
        });
        let resData: any = {};
        try {
          resData = await response.json();
        } catch (e) {
          console.error('Error parsing JSON response:', e);
        }

        if (!response.ok) {
          const errMsg = resData.error || resData.message || resData.details || `Error del servidor (Status ${response.status})`;
          throw new Error(errMsg);
        }
        setSyncStatus('success');
        setSyncStats({
          products: productsList.length,
          stocks: stocksList.length,
        });
      } catch (err: any) {
        console.error(err);
        setSyncStatus('error');
        setSyncErrorMessage(err.message || 'Error al procesar el archivo de inventario.');
      }
    };

    reader.onerror = () => {
      setSyncStatus('error');
      setSyncErrorMessage('Error al leer el archivo Excel.');
    };

    reader.readAsBinaryString(file);
  };

  // Cargar y Analizar Solicitud de Cliente
  const handleQuoteUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setQuoteFile(file);
    setIsAnalyzing(true);
    setAnalyzeError('');
    setQuoteItems([]);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet);

        if (rows.length === 0) {
          throw new Error('El archivo de solicitud de cliente está vacío.');
        }

        const clientItems: any[] = [];
        rows.forEach((row: any) => {
          const normalized: any = {};
          Object.keys(row).forEach((k) => {
            normalized[normalizeKey(k)] = row[k];
          });

          // Buscar columnas mapeadas flexibles para cliente
          const name = String(normalized.nombre_de_articulo || normalized.articulo || normalized.descripcion || normalized.name || '').trim();
          const quantity = parseFloat(normalized.cantidades || normalized.cantidad || normalized.quantity || normalized.cant || '1');

          if (name) {
            clientItems.push({ name, quantity });
          }
        });

        if (clientItems.length === 0) {
          throw new Error('No se encontraron artículos con cantidades válidas en el archivo de cliente.');
        }

        // Enviar ítems a la API Route para matching estructurado por chunks
        const response = await fetch('/api/matching/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: clientItems }),
        });

        const resData = await response.json();
        if (!response.ok) {
          throw new Error(resData.error || 'Error al analizar la cotización.');
        }

        const processedItems: QuoteItem[] = resData.results.map((r: any, idx: number) => ({
          id: idx,
          clientName: r.clientName,
          clientQuantity: r.clientQuantity,
          matchedProduct: r.matchedProduct,
          matchType: r.matchType,
          similarityScore: r.similarityScore,
          confidence: r.confidence,
        }));

        setQuoteItems(processedItems);
        setIsAnalyzing(false);
      } catch (err: any) {
        console.error(err);
        setIsAnalyzing(false);
        setAnalyzeError(err.message || 'Error al procesar el archivo del cliente.');
      }
    };

    reader.onerror = () => {
      setIsAnalyzing(false);
      setAnalyzeError('Error al leer el archivo del cliente.');
    };

    reader.readAsBinaryString(file);
  };

  // Autocompletado del Buscador de Productos (Capa 3)
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const delayDebounceFn = setTimeout(async () => {
      setIsSearchingProducts(true);
      try {
        const response = await fetch(`/api/products/search?query=${encodeURIComponent(searchQuery)}`);
        const data = await response.json();
        setSearchResults(data.products || []);
      } catch (err) {
        console.error('Error al realizar búsqueda de autocompletado:', err);
      } finally {
        setIsSearchingProducts(false);
      }
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery]);

  // Abrir interfaz de búsqueda manual en la fila
  const openManualSearch = (item: QuoteItem) => {
    setActiveSearchId(item.id);
    setSearchQuery(item.clientName); // Rellenar con la búsqueda original del cliente
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 100);
  };

  // Vincular Producto Seleccionado Manualmente (Guardar Alias y Actualizar UI)
  const selectProductManually = async (item: QuoteItem, product: ProductSearchResult) => {
    // 1. Obtener los lotes de stock de este producto seleccionado desde la base de datos
    try {
      // Nota: Para fines del flujo, hacemos un fetch rápido o simulamos la carga de stock.
      // Pero mejor hacemos una consulta a la API de búsqueda o stock. Como necesitamos stock y lotes, 
      // podemos hacer una consulta directa mediante una llamada RPC en backend o buscar en product_stocks.
      // Para optimizar, vamos a hacer un truco en el backend, o podemos llamar a match_client_product
      // pasando el nombre exacto de la descripción que acabamos de elegir para traer sus lotes
      const response = await fetch('/api/matching/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ name: product.description, quantity: item.clientQuantity }] }),
      });

      const resData = await response.json();
      let matchedInfo = {
        productId: product.id,
        code: product.code,
        description: product.description,
        presentation: product.presentation,
        manufacturer: product.manufacturer,
        iva: product.iva,
        unitPrice: product.unit_price,
        totalStock: 0,
        lots: [] as LotStock[],
      };

      if (response.ok && resData.results && resData.results.length > 0) {
        const matchedDetail = resData.results[0].matchedProduct;
        matchedInfo.totalStock = matchedDetail.totalStock;
        matchedInfo.lots = matchedDetail.lots;
      }

      // 2. Actualizar el estado local de la fila
      setQuoteItems((prev) =>
        prev.map((q) =>
          q.id === item.id
            ? {
                ...q,
                matchedProduct: matchedInfo,
                matchType: 'exact_alias',
                similarityScore: 1.0,
                confidence: 'high',
                isManualLink: true,
              }
            : q
        )
      );

      // 3. Guardar en base de datos la relación en `client_aliases` de forma asíncrona (Aprender para el futuro)
      fetch('/api/aliases/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientArticleName: item.clientName,
          productId: product.id,
        }),
      }).catch((e) => console.error('Error al persistir alias en background:', e));

      // Limpiar buscador
      setActiveSearchId(null);
      setSearchQuery('');
      setSearchResults([]);
    } catch (error) {
      console.error('Error al vincular el producto:', error);
      alert('Hubo un error al vincular el producto.');
    }
  };

  // Exportar Cotización Formateada (SheetJS - Ejecución Cliente)
  const handleExport = () => {
    if (quoteItems.length === 0) return;

    const headers = [
      'nombre de articulo',
      'cantidades',
      'código',
      'descripción',
      'presentación',
      'fabricante',
      'lote',
      'cantidad',
      'iva',
      'precio unitario',
    ];

    const dataRows: any[] = [];

    quoteItems.forEach((item) => {
      const matched = item.matchedProduct;

      // Si no hay match de producto, exportar fila en blanco en las columnas de inventario
      if (!matched.productId) {
        dataRows.push([
          item.clientName,
          item.clientQuantity,
          '',
          'SIN COINCIDENCIA',
          '',
          '',
          'SIN LOTE',
          0,
          0,
          0,
        ]);
        return;
      }

      // Si hay match y tiene stock, distribuir por lotes (FEFO simplificado)
      if (matched.lots && matched.lots.length > 0) {
        let remainingToAllocate = item.clientQuantity;
        
        // Clonar y ordenar lotes por cantidad (o fecha de vencimiento si viniera en el string)
        const sortedLots = [...matched.lots].sort((a, b) => b.quantity - a.quantity);

        const allocatedRows: any[] = [];

        for (const lotInfo of sortedLots) {
          if (remainingToAllocate <= 0) break;

          const take = Math.min(lotInfo.quantity, remainingToAllocate);
          if (take > 0) {
            allocatedRows.push({
              lot: lotInfo.lot,
              qty: take,
            });
            remainingToAllocate -= take;
          }
        }

        // Si se asignó stock pero aún falta cubrir la cantidad del cliente, registrar el resto como faltante o sin stock
        if (remainingToAllocate > 0) {
          allocatedRows.push({
            lot: 'SIN LOTE (STOCK INSUFICIENTE)',
            qty: remainingToAllocate,
          });
        }

        // Escribir fila por cada lote asignado en la cotización
        allocatedRows.forEach((alloc) => {
          dataRows.push([
            item.clientName,
            alloc.qty, // Cantidad tomada de este lote
            matched.code,
            matched.description,
            matched.presentation,
            matched.manufacturer,
            alloc.lot,
            lotInfoQty(matched.lots, alloc.lot), // Muestra el stock total de ese lote en el inventario
            matched.iva,
            matched.unitPrice,
          ]);
        });
      } else {
        // Si hay match pero no tiene registros de lote en inventario
        dataRows.push([
          item.clientName,
          item.clientQuantity,
          matched.code,
          matched.description,
          matched.presentation,
          matched.manufacturer,
          'SIN LOTE',
          0,
          matched.iva,
          matched.unitPrice,
        ]);
      }
    });

    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Cotización Procesada');
    XLSX.writeFile(wb, 'Cotizacion_Procesada_SmartQuote.xlsx');
  };

  const lotInfoQty = (lots: LotStock[], lotName: string): number => {
    const found = lots.find((l) => l.lot === lotName);
    return found ? found.quantity : 0;
  };

  // Crear archivos de prueba para facilitar el testeo del usuario
  const generateSampleInventory = () => {
    const headers = ['CODIGO', 'DESCRIPCIÓN', 'PRESENTACIÓN', 'FABRICANTE', 'LOTE', 'CANT', 'IVA', 'PRECIO UNITARIO'];
    const data = [
      ['PROD001', 'ACETAMINOFEN 500 MG TABLETA', 'Caja x 100', 'Genfar', 'LOTE:101A VENCE:12/2028', 1200, 0, 15.50],
      ['PROD001', 'ACETAMINOFEN 500 MG TABLETA', 'Caja x 100', 'Genfar', 'LOTE:102B VENCE:06/2029', 500, 0, 15.50],
      ['PROD002', 'IBUPROFENO 800 MG CAPSULA', 'Blister x 10', 'La Sante', 'LOTE:501Z VENCE:03/2027', 2000, 19, 45.00],
      ['PROD003', 'AMOXICILINA 500 MG SUSPENSION', 'Frasco 60ml', 'Abbott', 'LOTE:901T VENCE:01/2028', 150, 5, 120.00],
      ['PROD004', 'LOSARTAN POTASICO 50 MG', 'Caja x 30', 'Genfar', 'LOTE:805R VENCE:09/2028', 80, 0, 32.20],
      ['PROD005', 'VITAMINA C 500 MG MASTICABLE', 'Frasco x 100', 'MK', 'LOTE:333X VENCE:04/2028', 10, 0, 25.00]
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario Maestro');
    XLSX.writeFile(wb, 'Inventario_Diario_Test.xlsx');
  };

  const generateSampleQuoteRequest = () => {
    const headers = ['nombre de articulo', 'cantidades'];
    const data = [
      ['Acetaminofen 500mg tab', 1500], // Match exacto con typo menor (trigrama o alias)
      ['IBUPROFENO 800MG', 300],        // Match trigrama
      ['Amoxicilina susp 500 mg', 50],  // Match trigrama
      ['LOSARTAN POTASICO 50 MG', 100],  // Alerta de stock (100 solicitados, stock total es 80)
      ['Loratadina 10 mg tab', 20],      // Sin coincidencia (para resolver con dropdown manual)
      ['PROD005', 5]                    // Match exacto por código
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Solicitud Cliente');
    XLSX.writeFile(wb, 'Solicitud_Cliente_Test.xlsx');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased">
      {/* Barra superior estética */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-50 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 to-teal-400 flex items-center justify-center font-bold text-slate-900 shadow-lg shadow-indigo-500/20">
            SQ
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-indigo-200 via-teal-200 to-white bg-clip-text text-transparent">
              SmartQuote
            </h1>
            <p className="text-xs text-slate-400">Automatización Inteligente de Cotizaciones</p>
          </div>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={generateSampleInventory}
            className="px-3 py-1.5 rounded-lg border border-indigo-500/30 hover:border-indigo-400 bg-indigo-950/20 text-xs font-semibold text-indigo-300 hover:text-indigo-200 transition-all cursor-pointer"
          >
            📥 Inventario de Prueba
          </button>
          <button 
            onClick={generateSampleQuoteRequest}
            className="px-3 py-1.5 rounded-lg border border-teal-500/30 hover:border-teal-400 bg-teal-950/20 text-xs font-semibold text-teal-300 hover:text-teal-200 transition-all cursor-pointer"
          >
            📥 Solicitud de Prueba
          </button>
        </div>
      </header>

      {/* Contenedor Principal */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        {/* Panel Izquierdo: Carga de Datos y Status (Col-span 1) */}
        <section className="lg:col-span-1 flex flex-col gap-6">
          
          {/* Tarjeta 1: Carga de Inventario Maestro */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl backdrop-blur">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-indigo-400 text-lg">📁</span>
              <h2 className="font-semibold text-sm text-slate-200 tracking-wide uppercase">
                1. Inventario Maestro
              </h2>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Cargue el inventario Excel diario. El sistema actualizará el catálogo maestro y los lotes activos atómicamente.
            </p>

            <div className="relative border border-dashed border-slate-700 hover:border-indigo-500/60 rounded-xl p-4 transition-all flex flex-col items-center justify-center bg-slate-950/40 cursor-pointer">
              <input
                type="file"
                accept=".xlsx, .xls"
                onChange={handleInventoryUpload}
                disabled={syncStatus === 'loading'}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
              />
              <span className="text-2xl mb-1">📊</span>
              <span className="text-xs font-semibold text-slate-300">
                {inventoryFile ? inventoryFile.name : 'Seleccionar Excel de Inventario'}
              </span>
              <span className="text-[10px] text-slate-500 mt-1">Formatos admitidos: .xlsx, .xls</span>
            </div>

            {/* Estados de Sincronización */}
            {syncStatus === 'loading' && (
              <div className="mt-4 flex items-center gap-2 text-xs text-indigo-400 font-medium">
                <span className="animate-spin text-lg">⏳</span> Procesando e insertando en base de datos...
              </div>
            )}

            {syncStatus === 'success' && syncStats && (
              <div className="mt-4 p-3 bg-emerald-950/20 border border-emerald-800/40 rounded-lg">
                <div className="text-xs text-emerald-400 font-semibold mb-1">✓ Sincronización Exitosa</div>
                <div className="text-[10px] text-slate-300">
                  • {syncStats.products} productos upsertados.<br />
                  • {syncStats.stocks} lotes de existencias activos.
                </div>
              </div>
            )}

            {syncStatus === 'error' && (
              <div className="mt-4 p-3 bg-rose-950/20 border border-rose-800/40 rounded-lg">
                <div className="text-xs text-rose-400 font-semibold mb-1">✗ Error en la carga</div>
                <div className="text-[10px] text-slate-300">{syncErrorMessage}</div>
              </div>
            )}
          </div>

          {/* Tarjeta 2: Carga de Solicitud de Cliente */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl backdrop-blur">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-teal-400 text-lg">📄</span>
              <h2 className="font-semibold text-sm text-slate-200 tracking-wide uppercase">
                2. Solicitud de Cliente
              </h2>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Cargue el listado del cliente en formato Excel [nombre de articulo, cantidades] para iniciar el matching automático.
            </p>

            <div className="relative border border-dashed border-slate-700 hover:border-teal-500/60 rounded-xl p-4 transition-all flex flex-col items-center justify-center bg-slate-950/40 cursor-pointer">
              <input
                type="file"
                accept=".xlsx, .xls"
                onChange={handleQuoteUpload}
                disabled={isAnalyzing}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
              />
              <span className="text-2xl mb-1">🛒</span>
              <span className="text-xs font-semibold text-slate-300">
                {quoteFile ? quoteFile.name : 'Seleccionar Excel de Solicitud'}
              </span>
              <span className="text-[10px] text-slate-500 mt-1">Formatos admitidos: .xlsx, .xls</span>
            </div>

            {isAnalyzing && (
              <div className="mt-4 flex items-center gap-2 text-xs text-teal-400 font-medium">
                <span className="animate-spin text-lg">⚙️</span> Procesando capas de matching...
              </div>
            )}

            {analyzeError && (
              <div className="mt-4 p-3 bg-rose-950/20 border border-rose-800/40 rounded-lg">
                <div className="text-xs text-rose-400 font-semibold mb-1">✗ Error en análisis</div>
                <div className="text-[10px] text-slate-300">{analyzeError}</div>
              </div>
            )}
          </div>

          {/* Tarjeta 3: Métricas Rápidas */}
          {quoteItems.length > 0 && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl backdrop-blur flex flex-col gap-3">
              <h2 className="font-semibold text-xs text-slate-400 tracking-wider uppercase mb-1">Resumen del Proceso</h2>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/60">
                  <div className="text-xs text-slate-400">Total Items</div>
                  <div className="text-lg font-bold text-slate-200">{totals.totalItems}</div>
                </div>
                <div className="bg-emerald-950/10 p-2.5 rounded-xl border border-emerald-900/30">
                  <div className="text-xs text-emerald-400">Coincidentes</div>
                  <div className="text-lg font-bold text-emerald-400">{totals.matchedCount}</div>
                </div>
                <div className="bg-rose-950/10 p-2.5 rounded-xl border border-rose-900/30">
                  <div className="text-xs text-rose-400">Sin Match</div>
                  <div className="text-lg font-bold text-rose-400">{totals.unmatchedCount}</div>
                </div>
                <div className="bg-amber-950/10 p-2.5 rounded-xl border border-amber-900/30">
                  <div className="text-xs text-amber-400">Falta Stock</div>
                  <div className="text-lg font-bold text-amber-400">{totals.stockAlertsCount}</div>
                </div>
              </div>

              <button
                onClick={handleExport}
                className="w-full mt-2 py-3 bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 font-bold rounded-xl shadow-lg shadow-emerald-500/10 hover:shadow-emerald-500/20 active:scale-[0.98] transition-all text-sm cursor-pointer"
              >
                💾 Exportar Excel Procesado
              </button>
            </div>
          )}
        </section>

        {/* Panel Derecho: Tabla de Matching y Resolución UI (Col-span 3) */}
        <section className="lg:col-span-3 flex flex-col gap-4">
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl backdrop-blur flex flex-col flex-1 min-h-[500px]">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
              <div>
                <h2 className="font-bold text-lg text-slate-100">Vista Previa de Cotización</h2>
                <p className="text-xs text-slate-400">
                  Revise los resultados de matching. Las celdas amarillas indican coincidencia de baja confianza.
                </p>
              </div>
              {quoteItems.length > 0 && (
                <div className="flex items-center gap-4 text-xs font-semibold">
                  <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span> Alta Confianza</div>
                  <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block"></span> Media / Revisar</div>
                  <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block"></span> Sin Coincidencia</div>
                </div>
              )}
            </div>

            {quoteItems.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-500 text-center py-20">
                <span className="text-5xl mb-3">📋</span>
                <p className="text-sm font-medium">No hay cotizaciones cargadas.</p>
                <p className="text-xs max-w-xs mt-1">Cargue un archivo de solicitud de cliente en el panel izquierdo para comenzar.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-[10px] text-slate-400 tracking-wider uppercase">
                      <th className="py-3 px-3">Artículo Solicitado</th>
                      <th className="py-3 px-3 text-right">Cant.</th>
                      <th className="py-3 px-3">Catálogo Maestro</th>
                      <th className="py-3 px-3">Lotes y Stock</th>
                      <th className="py-3 px-3 text-right">Precio Unitario</th>
                      <th className="py-3 px-3">Método / Estado</th>
                      <th className="py-3 px-3 text-center">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50 text-xs">
                    {quoteItems.map((item) => {
                      const isUnmatched = !item.matchedProduct.productId;
                      const isLowConfidence = item.confidence === 'low' || item.confidence === 'medium';
                      const hasStockAlert = item.matchedProduct.productId && item.matchedProduct.totalStock < item.clientQuantity;

                      // Definir clases de fondo según la confianza
                      let rowBgClass = 'hover:bg-slate-800/20';
                      if (isUnmatched) {
                        rowBgClass = 'bg-rose-950/10 hover:bg-rose-950/20 border-l-2 border-rose-500';
                      } else if (isLowConfidence) {
                        rowBgClass = 'bg-amber-950/10 hover:bg-amber-950/20 border-l-2 border-amber-500';
                      } else if (item.isManualLink) {
                        rowBgClass = 'bg-indigo-950/10 hover:bg-indigo-950/20 border-l-2 border-indigo-500';
                      } else {
                        rowBgClass = 'hover:bg-slate-800/20 border-l-2 border-emerald-500';
                      }

                      return (
                        <tr key={item.id} className={`transition-colors ${rowBgClass}`}>
                          {/* Artículo Solicitado */}
                          <td className="py-3.5 px-3 font-medium text-slate-200 max-w-[200px] truncate">
                            {item.clientName}
                          </td>

                          {/* Cantidad Solicitada */}
                          <td className="py-3.5 px-3 text-right font-semibold text-slate-300">
                            {item.clientQuantity}
                          </td>

                          {/* Producto del Catálogo Maestro */}
                          <td className="py-3.5 px-3 max-w-[250px] relative">
                            {activeSearchId === item.id ? (
                              <div className="absolute top-1 left-2 right-2 z-10 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl p-2 w-[280px]">
                                <input
                                  ref={searchInputRef}
                                  type="text"
                                  placeholder="Escriba para buscar..."
                                  value={searchQuery}
                                  onChange={(e) => setSearchQuery(e.target.value)}
                                  className="w-full px-2.5 py-1.5 bg-slate-950 text-slate-100 border border-slate-700 rounded-md focus:outline-none focus:border-indigo-500 text-xs"
                                />
                                {isSearchingProducts && (
                                  <div className="text-[10px] text-slate-400 mt-1.5 px-1 animate-pulse">Buscando productos...</div>
                                )}
                                <div className="max-h-48 overflow-y-auto mt-2 divide-y divide-slate-800">
                                  {searchResults.length === 0 && !isSearchingProducts && searchQuery.trim() !== '' ? (
                                    <div className="text-[10px] text-slate-500 py-2 px-1">No se encontraron productos.</div>
                                  ) : (
                                    searchResults.map((prod) => (
                                      <button
                                        key={prod.id}
                                        onClick={() => selectProductManually(item, prod)}
                                        className="w-full text-left py-1.5 px-2 hover:bg-slate-800 text-[10px] rounded transition-colors block"
                                      >
                                        <div className="font-semibold text-slate-200">{prod.description}</div>
                                        <div className="text-slate-400 text-[9px] flex justify-between mt-0.5">
                                          <span>Cod: {prod.code}</span>
                                          <span>{prod.presentation}</span>
                                        </div>
                                      </button>
                                    ))
                                  )}
                                </div>
                                <button
                                  onClick={() => setActiveSearchId(null)}
                                  className="w-full text-center mt-2 py-1 bg-slate-800 text-slate-300 text-[9px] font-bold rounded hover:bg-slate-700 transition-colors"
                                >
                                  Cerrar
                                </button>
                              </div>
                            ) : null}

                            {!isUnmatched ? (
                              <div>
                                <div className="font-semibold text-slate-200 truncate">
                                  {item.matchedProduct.description}
                                </div>
                                <div className="text-[10px] text-slate-400 flex items-center gap-2 mt-0.5">
                                  <span>Cod: {item.matchedProduct.code}</span>
                                  <span>•</span>
                                  <span className="max-w-[120px] truncate">{item.matchedProduct.manufacturer}</span>
                                </div>
                              </div>
                            ) : (
                              <span className="text-rose-400 italic">No asociado</span>
                            )}
                          </td>

                          {/* Lotes y Stock */}
                          <td className="py-3.5 px-3">
                            {!isUnmatched ? (
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-1.5">
                                  <span className={`font-semibold ${hasStockAlert ? 'text-rose-400' : 'text-slate-300'}`}>
                                    Stock: {item.matchedProduct.totalStock}
                                  </span>
                                  {hasStockAlert && (
                                    <span className="px-1.5 py-0.5 rounded bg-rose-950/60 border border-rose-800/40 text-[9px] text-rose-400 font-bold animate-pulse">
                                      Falta Stock
                                    </span>
                                  )}
                                </div>
                                {item.matchedProduct.lots && item.matchedProduct.lots.length > 0 && (
                                  <div className="max-h-12 overflow-y-auto pr-1">
                                    {item.matchedProduct.lots.map((l, lIdx) => (
                                      <div key={lIdx} className="text-[9px] text-slate-400 flex justify-between gap-2">
                                        <span className="truncate max-w-[80px]">{l.lot}</span>
                                        <span className="font-medium">Qty: {l.quantity}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-500">-</span>
                            )}
                          </td>

                          {/* Precio Unitario */}
                          <td className="py-3.5 px-3 text-right font-semibold text-slate-200">
                            {!isUnmatched ? `$${item.matchedProduct.unitPrice.toFixed(2)}` : '-'}
                          </td>

                          {/* Método / Estado */}
                          <td className="py-3.5 px-3">
                            <div className="flex flex-col gap-1">
                              {isUnmatched ? (
                                <span className="inline-flex items-center justify-center w-fit px-2 py-0.5 rounded-full text-[9px] font-bold bg-rose-950 text-rose-400 border border-rose-800/30">
                                  Sin Coincidencia
                                </span>
                              ) : (
                                <span className={`inline-flex items-center justify-center w-fit px-2 py-0.5 rounded-full text-[9px] font-bold ${
                                  item.confidence === 'high'
                                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/30'
                                    : 'bg-amber-950 text-amber-400 border border-amber-800/30'
                                }`}>
                                  {item.matchType === 'exact_alias' ? 'Alias Guardado' :
                                   item.matchType === 'exact_product' ? 'Exacto Catálogo' :
                                   `Trigrama (${Math.round(item.similarityScore * 100)}%)`}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Acciones */}
                          <td className="py-3.5 px-3 text-center">
                            <button
                              onClick={() => openManualSearch(item)}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-indigo-600 hover:text-white rounded border border-slate-700 hover:border-indigo-500 font-medium text-[10px] text-slate-300 transition-all cursor-pointer"
                            >
                              🔍 Resolver
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-4 px-6 text-center text-[10px] text-slate-500">
        © 2026 SmartQuote. Arquitectura Serverless de Alto Rendimiento en Next.js, SheetJS y Supabase.
      </footer>
    </div>
  );
}
