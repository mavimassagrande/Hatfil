import type { Express } from "express";
import { createServer, type Server } from "http";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import multer from "multer";
import { chatStorage } from "./replit_integrations/chat/storage";
import { arkeService, formatArkeDataAsTable, arkeLogin } from "./arke";
import { orderDraftService } from "./orderDraft";
import { db } from "./db";
import { agents, conversations, colorFolders, colors, masterProducts, generatedProducts, customColors } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { requestContext } from "./request-context";

const upload = multer({ storage: multer.memoryStorage() });

const HATFIL_SUPPLIER_ID = "67b2e189-b9ee-42af-8aa9-ddd8bf6e2e62";
const HATFIL_SUPPLIER_NAME = "HATFIL TEKSTİL İŞLETMELERİ A.Ş.";
const HATFIL_SUPPLIER_VAT = "4699350981";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const anthropic = new Anthropic({
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY!,
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
});

const ARKE_SYSTEM_PROMPT = `RUOLO: Wizard di Ferro per ordini vendita Arke.
DATA: 21 Gennaio 2026

=== SEQUENZA OBBLIGATORIA (BLOCCANTE) ===
Step 1: CLIENTE → Solo search_customer e draft_set_customer permessi
Step 2: INDIRIZZO → Solo set_shipping_address permesso  
Step 3: PRODOTTI → search_product, draft_add_item, draft_remove_item permessi
Step 4: CONFERMA → submit_order permesso

NON puoi saltare step. Se il cliente manca, RIFIUTA qualsiasi richiesta prodotti.

=== FORMATO RISPOSTA OBBLIGATORIO ===
OGNI risposta DEVE iniziare con lo STATO DB letto in tempo reale:

--- STATO DB ---
Cliente: [nome o MANCANTE]
Indirizzo: [indirizzo o MANCANTE]
Articoli: [numero]
-----------------

[Il tuo messaggio qui]

=== DIVIETO ASSOLUTO DI ALLUCINAZIONE ===
NON scrivere MAI:
- "Ho impostato..." senza aver chiamato il tool
- "Indirizzo confermato..." senza set_shipping_address  
- "Prodotto aggiunto..." senza draft_add_item

Se un tool FALLISCE, scrivi ESATTAMENTE:
"ERRORE TECNICO: [descrizione errore dal tool]"

Solo se il tool restituisce SUCCESSO puoi confermare l'azione.

=== WORKFLOW STEP-BY-STEP ===

**STEP 1 - CLIENTE**
- Chiedi nome cliente se non fornito
- Chiama search_customer
- Mostra risultati, chiedi conferma
- Chiama draft_set_customer con UUID
- Avanza automaticamente a STEP 2

**STEP 2 - INDIRIZZO**
- Mostra lista indirizzi del cliente
- Chiedi quale usare (numero o testo)
- Chiama set_shipping_address
- Avanza automaticamente a STEP 3

**STEP 3 - PRODOTTI**
- Permetti ricerca prodotti
- Chiama draft_add_item per ogni prodotto
- Permetti rimozioni con draft_remove_item
- Quando utente dice "basta"/"conferma" → STEP 4

**STEP 4 - CONFERMA**
- Mostra riepilogo completo
- Chiedi conferma esplicita
- Chiama submit_order
- Mostra ID ordine Arke dalla risposta

=== REGOLE TECNICHE ===
- draft_add_item SOVRASCRIVE la quantità (idempotente)
- Ordini a totale €0 sono validi (campionatura)
- Usa CODICE prodotto (es. "PARSLEY 12 - RAW") per draft_add_item

Rispondi in italiano. Sii breve e preciso.`;

interface ArkeToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

async function executeArkeOperation(operation: ArkeToolCall, conversationId?: number): Promise<string> {
  try {
    switch (operation.name) {
      // ==================== SEARCH ====================
      case "search_customer": {
        const args = operation.arguments as { search: string };
        const result = await arkeService.listCustomers({ search: args.search, limit: 10 });
        if (!result.success) return `Errore: ${result.error}`;
        const customers = result.data as Array<{id: string; name: string; addresses?: Array<{country?: string; address?: string}>; vat_no?: string}>;
        if (!customers || customers.length === 0) return `Nessun cliente trovato per "${args.search}".`;
        let output = `Trovati ${customers.length} clienti:\n`;
        customers.slice(0, 10).forEach((c, i) => {
          const addr = c.addresses?.[0];
          const location = addr?.country || addr?.address || "";
          output += `${i + 1}. ${c.name}${location ? ` - ${location}` : ""}\n`;
          output += `   ID: ${c.id}\n`;
        });
        return output;
      }
      
      case "search_product": {
        const args = operation.arguments as { search: string };
        let searchTerm = args.search;
        let result = await arkeService.listProducts({ search: searchTerm, limit: 15 });
        
        // Se nessun risultato, prova con ricerca più flessibile
        if (result.success && (!result.data || (result.data as Array<unknown>).length === 0)) {
          // Prova rimuovendo trattini e spazi extra
          const flexibleSearch = searchTerm.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
          if (flexibleSearch !== searchTerm) {
            result = await arkeService.listProducts({ search: flexibleSearch, limit: 15 });
          }
          
          // Se ancora nessun risultato, prova con la prima parola
          if (!result.data || (result.data as Array<unknown>).length === 0) {
            const firstWord = searchTerm.split(/[\s-_]+/)[0];
            if (firstWord && firstWord.length >= 3 && firstWord !== searchTerm) {
              result = await arkeService.listProducts({ search: firstWord, limit: 15 });
              if (result.success && result.data && (result.data as Array<unknown>).length > 0) {
                searchTerm = firstWord; // Nota per l'output
              }
            }
          }
        }
        
        if (!result.success) return `Errore: ${result.error}`;
        const products = result.data as Array<{id: string; internal_id: string; name: string; uom: string; prices?: {currency?: string; unit?: number}}>;
        
        if (!products || products.length === 0) {
          return `Nessun prodotto trovato per "${args.search}".\n\nSuggerimenti:\n- Prova con un termine più generico (es. solo il nome del filato)\n- Controlla l'ortografia\n- Usa il codice prodotto se lo conosci`;
        }
        
        let output = "";
        if (searchTerm !== args.search) {
          output = `Nessun risultato esatto per "${args.search}", ma ho trovato ${products.length} prodotti simili cercando "${searchTerm}":\n\n`;
        } else {
          output = `Trovati ${products.length} prodotti:\n\n`;
        }
        
        products.slice(0, 15).forEach((p, i) => {
          const price = p.prices?.unit || 0;
          const currency = p.prices?.currency || "EUR";
          output += `${i + 1}. [ID: ${p.id}] - CODICE: "${p.internal_id}" - NOME: ${p.name} - PREZZO: ${currency} ${price}/${p.uom}\n`;
        });
        output += `\nPer aggiungere: usa draft_add_item con il CODICE (es. "${products[0]?.internal_id}") e la quantità.`;
        return output;
      }
      
      // ==================== ORDER DRAFT ====================
      case "draft_set_customer": {
        if (!conversationId) return "Errore: conversationId mancante";
        const args = operation.arguments as { customerId: string };
        const result = await arkeService.getCustomer(args.customerId);
        if (!result.success) return `Errore: ${result.error}`;
        const customer = result.data as {
          id: string;
          name: string;
          addresses?: Array<{ name?: string; address?: string; country?: string }>;
          vat_no?: string;
          default_currency?: string;
        };
        if (!customer) return "Cliente non trovato.";
        await orderDraftService.setCustomer(conversationId, customer);
        
        // Mostra cliente e lista indirizzi - l'agente DEVE chiedere quale usare
        const addresses = customer.addresses || [];
        let output = `Cliente "${customer.name}" impostato.\n\n`;
        if (addresses.length === 0) {
          output += "Nessun indirizzo disponibile per questo cliente.";
        } else if (addresses.length === 1) {
          output += `Indirizzo disponibile:\n1. ${addresses[0].address || ""} - ${addresses[0].country || ""}\n\nChiedi all'utente di confermare questo indirizzo.`;
        } else {
          output += `Indirizzi disponibili:\n`;
          addresses.forEach((a, i) => {
            output += `${i + 1}. ${a.address || ""} - ${a.country || ""}\n`;
          });
          output += `\nCHIEDI ALL'UTENTE: "Quale indirizzo vuoi usare per la spedizione?" poi usa set_shipping_address.`;
        }
        return output;
      }
      
      case "set_shipping_address": {
        if (!conversationId) return "Errore: conversationId mancante";
        const args = operation.arguments as { address: string };
        const message = await orderDraftService.setShippingAddress(conversationId, args.address);
        return message;
      }
      
      case "set_shipping_date": {
        if (!conversationId) return "Errore: conversationId mancante";
        const args = operation.arguments as { date: string };
        const message = await orderDraftService.setShippingDate(conversationId, args.date);
        return message;
      }
      
      case "draft_add_item": {
        if (!conversationId) return "Errore: conversationId mancante";
        const args = operation.arguments as { internal_id: string; quantity: number };
        
        // Normalizza input: rimuovi virgolette, spazi extra, trim
        let cleanId = args.internal_id
          .replace(/["""'']/g, '')  // Rimuovi virgolette
          .replace(/\s+/g, ' ')      // Normalizza spazi multipli
          .trim();
        
        console.log(`[draft_add_item] === PAYLOAD RICEVUTO ===`);
        console.log(`[draft_add_item] Raw internal_id: "${args.internal_id}"`);
        console.log(`[draft_add_item] Clean internal_id: "${cleanId}"`);
        console.log(`[draft_add_item] Quantity: ${args.quantity}`);
        console.log(`[draft_add_item] ConversationId: ${conversationId}`);
        
        // Verifica se è un UUID (36 caratteri con trattini)
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);
        console.log(`[draft_add_item] Is UUID: ${isUUID}`);
        
        let result;
        if (isUUID) {
          // Se è un UUID, cerca per ID diretto
          console.log(`[draft_add_item] Cercando per UUID...`);
          result = await arkeService.getProduct(cleanId);
          if (result.success && result.data) {
            // Converti singolo prodotto in array
            result.data = [result.data];
          }
        } else {
          // Altrimenti cerca per internal_id (codice)
          console.log(`[draft_add_item] Cercando per CODICE/internal_id...`);
          result = await arkeService.listProducts({ search: cleanId, limit: 10 });
        }
        
        if (!result.success) {
          console.log(`[draft_add_item] ERRORE API Arke: ${result.error}`);
          // Messaggio errore specifico
          if (result.error?.includes('timeout') || result.error?.includes('ECONNREFUSED')) {
            return `Errore di connessione ad Arke: impossibile raggiungere il server. Riprova tra poco.`;
          }
          if (result.error?.includes('401') || result.error?.includes('403')) {
            return `Errore di autenticazione con Arke. Contattare l'amministratore.`;
          }
          return `Errore API Arke: ${result.error}`;
        }
        
        const products = result.data as Array<{
          id: string;
          internal_id: string;
          name: string;
          uom: string;
          prices?: { currency?: string; unit?: number; vat?: number };
        }>;
        
        console.log(`[draft_add_item] Prodotti trovati: ${products?.length || 0}`);
        if (products && products.length > 0) {
          console.log(`[draft_add_item] Primo prodotto: ${JSON.stringify(products[0])}`);
        }
        
        if (!products || products.length === 0) {
          return `Prodotto "${cleanId}" non trovato nel catalogo Arke. Verifica il codice o usa search_product per cercarlo.`;
        }
        
        // Cerca match esatto per internal_id o id
        let product = products.find(p => 
          p.internal_id === cleanId || 
          p.internal_id?.toLowerCase() === cleanId.toLowerCase() ||
          p.id === cleanId
        );
        
        if (!product) {
          // Se non c'è match esatto, usa il primo risultato ma avvisa
          product = products[0];
          console.log(`[draft_add_item] No exact match, using first result: ${product.internal_id}`);
        }
        
        console.log(`[draft_add_item] Prodotto selezionato: ${product.internal_id} - ${product.name} - UUID: ${product.id}`);
        
        const message = await orderDraftService.addProduct(conversationId, {
          id: product.id,  // UUID del prodotto dal catalogo Arke
          internal_id: product.internal_id,
          name: product.name,
          quantity: args.quantity,
          uom: product.uom,
          prices: product.prices,
        });
        
        console.log(`[draft_add_item] Risultato salvataggio: ${message}`);
        return message + `\n\nUsa draft_show_summary per vedere il riepilogo dell'ordine.`;
      }
      
      case "draft_remove_item": {
        if (!conversationId) return "Errore: conversationId mancante";
        const args = operation.arguments as { internal_id: string };
        
        // Normalizza input
        let cleanId = args.internal_id
          .replace(/["""'']/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        
        console.log(`[draft_remove_item] Rimuovendo prodotto: "${cleanId}"`);
        
        const message = await orderDraftService.removeProduct(conversationId, cleanId);
        return message;
      }
      
      case "draft_show_summary": {
        if (!conversationId) return "Errore: conversationId mancante";
        return await orderDraftService.getSummary(conversationId);
      }
      
      case "clear_session": {
        if (!conversationId) return "Errore: conversationId mancante";
        return await orderDraftService.clear(conversationId);
      }
      
      case "submit_order": {
        if (!conversationId) return "Errore: conversationId mancante";
        
        // 1. Recupera draft dal DB
        const draft = await orderDraftService.getDraft(conversationId);
        
        // 2. Validazione base
        if (!draft.customer) {
          return "ORDINE NON INVIABILE: Manca il cliente. Usa search_customer e draft_set_customer prima di confermare.";
        }
        if (draft.products.length === 0) {
          return "ORDINE NON INVIABILE: Nessun prodotto nel carrello. Aggiungi almeno un prodotto con draft_add_item.";
        }
        
        // 3. Idratazione dati freschi - Cliente
        const customerResult = await arkeService.getCustomer(draft.customer.id);
        if (!customerResult.success || !customerResult.data) {
          return `Errore nel recuperare i dati del cliente: ${customerResult.error}`;
        }
        const freshCustomer = customerResult.data as {
          id: string;
          name: string;
          addresses?: Array<{ name?: string; address?: string; country?: string }>;
          vat_no?: string;
          default_currency?: string;
        };
        
        // 4. Costruisci customer_attr nel formato esatto del modello
        const customerAddr = freshCustomer.addresses?.[0];
        const customer_attr = {
          id: freshCustomer.id,
          name: freshCustomer.name,
          address: customerAddr?.address || "",
          country: customerAddr?.country || "",
          vat: freshCustomer.vat_no || "",
        };
        
        // 5. Costruisci shipping_address (usa l'indirizzo dal draft o dal cliente)
        const shipping_address = draft.shipping_address || 
          `${customer_attr.address}${customer_attr.country ? ` - ${customer_attr.country}` : ""}`;
        
        // 6. Idratazione dati freschi - Prodotti (recupera dati aggiornati per ogni prodotto)
        const hydratedProducts: Array<{
          id: string;
          extra_id: string;
          name: string;
          quantity: number;
          uom: string;
          prices: { currency: string; unit: number; vat: number; base_price: number; discount_percent: number };
        }> = [];
        
        for (const draftProduct of draft.products) {
          // Cerca il prodotto per codice per ottenere dati freschi
          const productResult = await arkeService.listProducts({ search: draftProduct.extra_id, limit: 5 });
          if (!productResult.success || !productResult.data) {
            console.error(`ERRORE: Impossibile recuperare prodotto ${draftProduct.extra_id} da Arke:`, productResult.error);
            return `ERRORE TECNICO: Impossibile verificare il prodotto "${draftProduct.extra_id}" con Arke. ${productResult.error || "Riprova tra poco."}`;
          }
          
          const products = productResult.data as Array<{
            id: string;
            internal_id: string;
            name: string;
            uom: string;
            prices?: { currency?: string; unit?: number; vat?: number };
          }>;
          
          // Trova il prodotto esatto
          let freshProduct = products.find(p => p.internal_id === draftProduct.extra_id);
          if (!freshProduct && products.length > 0) {
            freshProduct = products[0];
          }
          
          if (freshProduct) {
            hydratedProducts.push({
              id: freshProduct.id,
              extra_id: freshProduct.internal_id,
              name: freshProduct.name,
              quantity: draftProduct.quantity,
              uom: freshProduct.uom,
              prices: {
                currency: freshProduct.prices?.currency || "EUR",
                unit: freshProduct.prices?.unit || 0,
                vat: freshProduct.prices?.vat || 0,
                base_price: freshProduct.prices?.unit || 0,
                discount_percent: 0,
              },
            });
          } else {
            // Fallback - nessun prodotto trovato, errore critico
            console.error(`ERRORE CRITICO: Prodotto ${draftProduct.extra_id} non trovato in Arke durante idratazione`);
            return `ERRORE: Prodotto "${draftProduct.extra_id}" non trovato nel catalogo Arke. Rimuovilo e riprova.`;
          }
        }
        
        // 7. Calcola totali
        const total = hydratedProducts.reduce((sum, p) => sum + (p.prices.unit * p.quantity), 0);
        const total_vat_incl = hydratedProducts.reduce((sum, p) => {
          const lineTotal = p.prices.unit * p.quantity;
          const vatAmount = lineTotal * (p.prices.vat / 100);
          return sum + lineTotal + vatAmount;
        }, 0);
        
        // 8. Costruisci payload nel formato ESATTO del modello Arke
        const arkePayload = {
          customer_id: freshCustomer.id,
          customer_attr,
          default_currency: freshCustomer.default_currency || "EUR",
          expected_shipping_time: draft.expected_shipping_time || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          shipping_address,
          products: hydratedProducts,
          status: "draft" as const,  // SEMPRE bozza - l'utente confermerà in Arke
          notes: draft.notes || "",
          version: 1,
          total,
          total_vat_incl,
          priority: 3,
          time: new Date().toISOString(),
        };
        
        console.log("=== SUBMIT ORDER PAYLOAD ===");
        console.log(JSON.stringify(arkePayload, null, 2));
        
        // 9. Invia ordine ad Arke (SEMPRE come bozza)
        const orderResult = await arkeService.createSalesOrder({
          customer_id: arkePayload.customer_id,
          customer_attr: arkePayload.customer_attr,
          expected_shipping_time: arkePayload.expected_shipping_time,
          shipping_address: arkePayload.shipping_address,
          products: arkePayload.products.map(p => ({
            id: p.id,  // UUID del prodotto dal catalogo Arke
            extra_id: p.extra_id,
            name: p.name,
            quantity: p.quantity,
            uom: p.uom,
            prices: p.prices,
          })),
          status: "draft",  // SEMPRE bozza
          notes: arkePayload.notes,
          default_currency: arkePayload.default_currency,
        });
        
        // 10. Gestione risultato - RESTITUISCE JSON GREZZO ARKE
        if (orderResult.success && orderResult.data) {
          const createdOrder = orderResult.data as { id: string; internal_id?: string; [key: string]: unknown };
          // Successo: pulisci sessione e restituisci RISPOSTA GREZZA ARKE
          await orderDraftService.clear(conversationId);
          
          const arkeResponse = JSON.stringify(createdOrder, null, 2);
          console.log("=== ARKE API RESPONSE (RAW) ===");
          console.log(arkeResponse);
          
          return `ORDINE CREATO CON SUCCESSO!

=== RISPOSTA GREZZA ARKE ===
${arkeResponse}
============================

ID Ordine: ${createdOrder.internal_id || createdOrder.id}
Cliente: ${customer_attr.name}
Prodotti: ${hydratedProducts.length}
Totale: €${total.toFixed(2)}

L'ordine è stato registrato in Arke. Sessione resettata.`;
        } else {
          // Errore: mantieni draft e spiega problema
          console.error("=== ERRORE CREAZIONE ORDINE ===");
          console.error("Error:", orderResult.error);
          console.error("Payload inviato:", JSON.stringify(arkePayload, null, 2));
          return `ERRORE TECNICO: Creazione ordine fallita.

Dettaglio errore: ${orderResult.error}

Il carrello NON è stato svuotato. Puoi correggere i dati e riprovare.`;
        }
      }
      
      default:
        return `Operazione non supportata: ${operation.name}`;
    }
  } catch (error) {
    console.error("Arke operation error:", error);
    return `Errore nell'esecuzione dell'operazione: ${error instanceof Error ? error.message : "Errore sconosciuto"}`;
  }
}

const ARKE_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  { type: "function", function: { name: "search_customer", description: "Cerca un cliente per nome. Restituisce ID, dati e lista indirizzi disponibili.", parameters: { type: "object", properties: { search: { type: "string", description: "Nome o parte del nome del cliente da cercare" } }, required: ["search"] } } },
  { type: "function", function: { name: "search_product", description: "Cerca prodotti per nome, codice o categoria. Restituisce lista numerata con ID, codice, nome e prezzo.", parameters: { type: "object", properties: { search: { type: "string", description: "Nome, codice o categoria del prodotto da cercare" } }, required: ["search"] } } },
  { type: "function", function: { name: "draft_set_customer", description: "Imposta il cliente per l'ordine corrente. SALVA nel DB.", parameters: { type: "object", properties: { customerId: { type: "string", description: "ID del cliente (UUID)" } }, required: ["customerId"] } } },
  { type: "function", function: { name: "set_shipping_address", description: "SALVA l'indirizzo di spedizione nel database. Obbligatorio dopo che l'utente sceglie l'indirizzo.", parameters: { type: "object", properties: { address: { type: "string", description: "Indirizzo completo (es. 'Via Roma 1 - IT')" } }, required: ["address"] } } },
  { type: "function", function: { name: "set_shipping_date", description: "SALVA la data di spedizione nel database. Formato ISO o descrittivo.", parameters: { type: "object", properties: { date: { type: "string", description: "Data spedizione (es. '2026-02-01' o 'tra 2 settimane')" } }, required: ["date"] } } },
  { type: "function", function: { name: "draft_add_item", description: "Aggiunge/aggiorna prodotto (SOVRASCRIVE quantità). SALVA nel DB. Usa il CODICE dopo 'ID:' nei risultati di search_product.", parameters: { type: "object", properties: { internal_id: { type: "string", description: "Codice prodotto (es. 'CRISP 18') - usa il valore dopo 'ID:' nei risultati ricerca" }, quantity: { type: "number", description: "Quantità" } }, required: ["internal_id", "quantity"] } } },
  { type: "function", function: { name: "draft_remove_item", description: "Rimuove un prodotto dal carrello. Usa il CODICE del prodotto.", parameters: { type: "object", properties: { internal_id: { type: "string", description: "Codice prodotto da rimuovere" } }, required: ["internal_id"] } } },
  { type: "function", function: { name: "draft_show_summary", description: "Mostra riepilogo ordine DAL DATABASE. Evidenzia dati mancanti.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "clear_session", description: "Annulla ordine e resetta sessione.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "submit_order", description: "Invia ordine ad Arke. Richiede cliente e prodotti.", parameters: { type: "object", properties: {} } } },
];

// Helper description for date parameters
const DATE_PARAM_DESC = "Data in formato YYYY-MM-DD o ISO. Parole chiave accettate dall'AI: 'gennaio 2026' → '2026-01-01', 'Q1 2026' → date range, 'ultimo mese' → date dinamiche";

const ANALISI_VENDITE_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  { type: "function", function: { name: "sales_search_customer", description: "Cerca un cliente per nome per poi vedere i suoi ordini.", parameters: { type: "object", properties: { search: { type: "string", description: "Nome o parte del nome del cliente" } }, required: ["search"] } } },
  { type: "function", function: { name: "sales_by_customer", description: "Mostra tutti gli ordini di un cliente specifico. Supporta filtro temporale.", parameters: { type: "object", properties: { customer_id: { type: "string", description: "ID del cliente (UUID)" }, limit: { type: "number", description: "Numero massimo di ordini (default 20)" }, date_from: { type: "string", description: "Data inizio periodo (YYYY-MM-DD)" }, date_to: { type: "string", description: "Data fine periodo (YYYY-MM-DD)" } }, required: ["customer_id"] } } },
  { type: "function", function: { name: "sales_summary", description: "Mostra riepilogo vendite. Se specificate date mostra quel periodo, altrimenti ultimi 2 mesi.", parameters: { type: "object", properties: { date_from: { type: "string", description: "Data inizio periodo (YYYY-MM-DD)" }, date_to: { type: "string", description: "Data fine periodo (YYYY-MM-DD)" } } } } },
  { type: "function", function: { name: "active_orders", description: "Mostra ordini attivi (in corso, non ancora spediti).", parameters: { type: "object", properties: { limit: { type: "number", description: "Numero massimo di ordini (default 20)" } } } } },
  { type: "function", function: { name: "order_details", description: "Mostra i dettagli completi di un ordine specifico.", parameters: { type: "object", properties: { order_id: { type: "string", description: "ID dell'ordine (UUID o codice come SO-2026/0001)" } }, required: ["order_id"] } } },
  { type: "function", function: { name: "all_orders", description: "Lista ordini con filtri flessibili. Filtra per cliente, prodotto, stato e data. USALO SEMPRE quando cerchi ordini di un cliente o ordini con un prodotto specifico.", parameters: { type: "object", properties: { customer: { type: "string", description: "Filtra per nome cliente (es. 'Highline', 'MADEWELL')" }, product: { type: "string", description: "Filtra per codice/nome prodotto (es. 'CHURRO 7000', 'PARSLEY', 'PANEL')" }, status: { type: "string", description: "Stato ordine: draft, accepted, sent" }, limit: { type: "number", description: "Numero massimo (default 50)" }, date_from: { type: "string", description: "Data inizio periodo (YYYY-MM-DD)" }, date_to: { type: "string", description: "Data fine periodo (YYYY-MM-DD)" } } } } },
  { type: "function", function: { name: "top_products", description: "Classifica dei prodotti più venduti. Analizza gli ordini e aggrega le quantità per prodotto. Supporta filtro temporale e filtro codice.", parameters: { type: "object", properties: { limit: { type: "number", description: "Numero di prodotti da mostrare (default 10)" }, filter: { type: "string", description: "Filtra prodotti che contengono questa stringa nel CODICE (es. 'PANEL', 'PARSLEY', 'RAW')" }, date_from: { type: "string", description: "Data inizio periodo (YYYY-MM-DD)" }, date_to: { type: "string", description: "Data fine periodo (YYYY-MM-DD)" } } } } },
  { type: "function", function: { name: "top_products_by_customer", description: "Per ogni cliente, mostra il prodotto che ha acquistato di più. Supporta filtro temporale.", parameters: { type: "object", properties: { limit: { type: "number", description: "Numero di clienti da mostrare (default 20)" }, date_from: { type: "string", description: "Data inizio periodo (YYYY-MM-DD)" }, date_to: { type: "string", description: "Data fine periodo (YYYY-MM-DD)" } } } } },
  { type: "function", function: { name: "sales_by_country", description: "Vendite raggruppate per nazionalità/paese del cliente. Supporta filtro temporale.", parameters: { type: "object", properties: { date_from: { type: "string", description: "Data inizio periodo (YYYY-MM-DD)" }, date_to: { type: "string", description: "Data fine periodo (YYYY-MM-DD)" } } } } },
  { type: "function", function: { name: "orders_by_agent", description: "Mostra ordini e vendite di un agente commerciale specifico. Supporta filtro temporale.", parameters: { type: "object", properties: { agent_name: { type: "string", description: "Nome dell'agente commerciale da cercare" }, limit: { type: "number", description: "Numero massimo ordini (default 30)" }, date_from: { type: "string", description: "Data inizio periodo (YYYY-MM-DD)" }, date_to: { type: "string", description: "Data fine periodo (YYYY-MM-DD)" } }, required: ["agent_name"] } } },
  { type: "function", function: { name: "agent_ranking", description: "Classifica degli agenti commerciali per numero ordini e fatturato totale. Supporta filtro temporale.", parameters: { type: "object", properties: { limit: { type: "number", description: "Numero di agenti da mostrare (default 10)" }, date_from: { type: "string", description: "Data inizio periodo (YYYY-MM-DD)" }, date_to: { type: "string", description: "Data fine periodo (YYYY-MM-DD)" } } } } },
];

// ==================== MAGAZZINO TOOLS ====================
const MAGAZZINO_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  { type: "function", function: { name: "list_warehouses", description: "Lista tutti i magazzini disponibili con nome, tipo e indirizzo.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "search_inventory", description: "Mostra tutte le giacenze in magazzino ordinate per quantità. Opzionalmente filtra per nome prodotto e/o magazzino specifico.", parameters: { type: "object", properties: { search: { type: "string", description: "Nome o codice prodotto da filtrare (opzionale, se vuoto mostra tutto)" }, warehouse: { type: "string", description: "Nome del magazzino da filtrare (es. 'Brescia', 'Milano'). Se specificato, mostra solo giacenze di quel magazzino." }, limit: { type: "number", description: "Numero massimo risultati (default 50)" } } } } },
  { type: "function", function: { name: "product_stock", description: "Giacenza dettagliata di un prodotto specifico, SUDDIVISA PER LOTTI FORNITORE. Usa questo per vedere tutti i lotti di un prodotto.", parameters: { type: "object", properties: { search: { type: "string", description: "Nome o codice prodotto (es. 'PARSLEY 12 - 0190')" }, product_id: { type: "string", description: "ID del prodotto (UUID) - opzionale se usi search" } } } } },
  { type: "function", function: { name: "inventory_movements", description: "Ultimi movimenti inventario. Mostra entrate, uscite e trasferimenti.", parameters: { type: "object", properties: { limit: { type: "number", description: "Numero movimenti da mostrare (default 20)" } } } } },
  { type: "function", function: { name: "low_stock_products", description: "Prodotti con giacenza bassa o esaurita. Utile per riordini.", parameters: { type: "object", properties: { threshold: { type: "number", description: "Soglia quantità minima (default 10)" }, limit: { type: "number", description: "Numero prodotti da mostrare (default 20)" } } } } },
];

async function executeMagazzinoOperation(operation: ArkeToolCall): Promise<string> {
  try {
    console.log(`[TOOL CALL - MAGAZZINO] ${operation.name} con Argomenti: ${JSON.stringify(operation.arguments)}`);
    
    switch (operation.name) {
      case "list_warehouses": {
        const result = await arkeService.listWarehouses();
        if (!result.success) return `Errore: ${result.error}`;
        const warehouses = result.data as Array<{
          id: string;
          name: string;
          type: string;
          active?: boolean;
          address?: { address: string; country: string; name: string };
        }>;
        if (!warehouses || warehouses.length === 0) return `Nessun magazzino trovato.`;
        
        let output = `**Magazzini Disponibili** (${warehouses.length})\n\n`;
        output += `| # | Nome | Tipo | Stato | Indirizzo |\n`;
        output += `|---|------|------|-------|----------|\n`;
        
        warehouses.forEach((w, i) => {
          const status = w.active !== false ? "Attivo" : "Inattivo";
          const addr = w.address?.address || "N/A";
          const typeLabel = w.type === "production_facility" ? "Produzione" : 
                           w.type === "distribution_center" ? "Distribuzione" :
                           w.type === "stock_at_subcontractor" ? "Conto lavoro" : w.type;
          output += `| ${i + 1} | ${w.name} | ${typeLabel} | ${status} | ${addr} |\n`;
        });
        return output;
      }
      
      case "search_inventory": {
        const args = operation.arguments as { search?: string; warehouse?: string; limit?: number };
        
        // If search term provided, first search in product catalog to find all variants
        if (args.search && args.search.trim()) {
          // Search products in catalog
          const productsResult = await arkeService.listProducts({ search: args.search, limit: 100 });
          if (!productsResult.success) return `Errore: ${productsResult.error}`;
          
          const products = productsResult.data as Array<{id: string; internal_id: string; name: string; uom: string}>;
          if (!products || products.length === 0) return `Nessun prodotto trovato per "${args.search}".`;
          
          // For each product, get inventory (if any)
          type ProductWithInventory = {
            product_id: string;
            internal_id: string;
            name: string;
            uom: string;
            available: number;
            reserved: number;
            planned: number;
            shipped: number;
            hasInventory: boolean;
            warehouse?: string;
          };
          
          const results: ProductWithInventory[] = [];
          
          // Batch inventory lookup - get all inventory items first
          const allInvItems = await arkeService.fetchAllInventoryItems();
          let allInventory = allInvItems as Array<{
            product_id: string;
            internal_id: string;
            warehouse_attr?: { id: string; name: string };
            buckets?: { available?: number; reserved?: number; in_production?: number; planned?: number; shipped?: number };
          }>;
          
          // Filter by warehouse if specified
          const warehouseFilter = args.warehouse?.trim().toLowerCase();
          if (warehouseFilter) {
            allInventory = allInventory.filter(inv => 
              inv.warehouse_attr?.name?.toLowerCase().includes(warehouseFilter)
            );
          }
          
          // Build inventory map by product_id
          const inventoryByProduct = new Map<string, { available: number; reserved: number; planned: number; shipped: number; warehouse: string }>();
          allInventory.forEach(inv => {
            const existing = inventoryByProduct.get(inv.product_id) || { available: 0, reserved: 0, planned: 0, shipped: 0, warehouse: inv.warehouse_attr?.name || "N/A" };
            existing.available += inv.buckets?.available || 0;
            existing.reserved += inv.buckets?.reserved || 0;
            existing.planned += inv.buckets?.planned || 0;
            existing.shipped += inv.buckets?.shipped || 0;
            inventoryByProduct.set(inv.product_id, existing);
          });
          
          // Match products with inventory
          for (const product of products) {
            const inv = inventoryByProduct.get(product.id);
            results.push({
              product_id: product.id,
              internal_id: product.internal_id,
              name: product.name,
              uom: product.uom,
              available: inv?.available || 0,
              reserved: inv?.reserved || 0,
              planned: inv?.planned || 0,
              shipped: inv?.shipped || 0,
              hasInventory: !!inv,
              warehouse: inv?.warehouse,
            });
          }
          
          // If warehouse filter is active, only show products with inventory in that warehouse
          const filteredResults = warehouseFilter 
            ? results.filter(r => r.hasInventory)
            : results;
          
          // Sort by available quantity descending, then by code
          filteredResults.sort((a, b) => (b.available - a.available) || a.internal_id.localeCompare(b.internal_id));
          
          // Calculate totals
          let totalAvailable = 0, totalReserved = 0, totalPlanned = 0;
          filteredResults.forEach(r => {
            totalAvailable += r.available;
            totalReserved += r.reserved;
            totalPlanned += r.planned;
          });
          
          const withStock = filteredResults.filter(r => r.hasInventory).length;
          
          // Build output header based on filters
          const warehouseLabel = warehouseFilter ? ` nel magazzino "${args.warehouse}"` : "";
          let output = `**Giacenze per "${args.search}"${warehouseLabel}**\n`;
          
          if (warehouseFilter) {
            output += `- **${withStock} varianti** con giacenze registrate\n`;
          } else {
            output += `- **${filteredResults.length} varianti** trovate nel catalogo, **${withStock}** con giacenze registrate\n`;
          }
          output += `- **Totale Disponibile: ${totalAvailable.toFixed(2)}** | Riservato: ${totalReserved.toFixed(2)} | Pianificato: ${totalPlanned.toFixed(2)}\n\n`;
          
          if (warehouseFilter) {
            output += `| Variante (Codice) | Disponibile | Riservato | Pianificato | Magazzino | UOM |\n`;
            output += `|-------------------|-------------|-----------|-------------|-----------|-----|\n`;
          } else {
            output += `| Variante (Codice) | Disponibile | Riservato | Pianificato | UOM | Giacenza |\n`;
            output += `|-------------------|-------------|-----------|-------------|-----|----------|\n`;
          }
          
          for (const item of filteredResults.slice(0, 30)) {
            if (warehouseFilter) {
              output += `| ${item.internal_id} | ${item.available.toFixed(2)} | ${item.reserved.toFixed(2)} | ${item.planned.toFixed(2)} | ${item.warehouse || "N/A"} | ${item.uom} |\n`;
            } else {
              const stockStatus = item.hasInventory ? "Si" : "No";
              output += `| ${item.internal_id} | ${item.available.toFixed(2)} | ${item.reserved.toFixed(2)} | ${item.planned.toFixed(2)} | ${item.uom} | ${stockStatus} |\n`;
            }
          }
          
          if (filteredResults.length > 30) {
            output += `\n_Mostrate 30 di ${filteredResults.length} varianti. Specifica il codice colore (es. "${args.search} - 0290") per dettagli._`;
          }
          
          if (warehouseFilter && filteredResults.length === 0) {
            output = `**Nessuna giacenza trovata per "${args.search}" nel magazzino "${args.warehouse}".**\n`;
            output += `Il prodotto potrebbe essere disponibile in altri magazzini. Prova senza il filtro magazzino.`;
          }
          
          return output;
        }
        
        // No search term - show all inventory items sorted by quantity
        const allInvData = await arkeService.fetchAllInventoryItems();
        
        let items = allInvData as Array<{
          id: string;
          name: string;
          internal_id: string;
          product_id: string;
          external_lot?: string;
          lot?: string;
          warehouse_attr?: { id: string; name: string };
          buckets?: { available?: number; reserved?: number; in_production?: number; planned?: number; shipped?: number };
          uom: string;
        }>;
        
        // Filter by warehouse if specified
        const warehouseFilterNoSearch = args.warehouse?.trim().toLowerCase();
        if (warehouseFilterNoSearch) {
          items = items.filter(item => 
            item.warehouse_attr?.name?.toLowerCase().includes(warehouseFilterNoSearch)
          );
        }
        
        if (!items || items.length === 0) {
          if (warehouseFilterNoSearch) {
            return `Nessuna giacenza trovata nel magazzino "${args.warehouse}".`;
          }
          return `Nessuna giacenza trovata in magazzino.`;
        }
        
        // Sort by available quantity descending
        items.sort((a, b) => (b.buckets?.available || 0) - (a.buckets?.available || 0));
        
        // Calculate totals
        let totalAvailable = 0, totalReserved = 0, totalPlanned = 0;
        items.forEach(item => {
          totalAvailable += item.buckets?.available || 0;
          totalReserved += item.buckets?.reserved || 0;
          totalPlanned += item.buckets?.planned || 0;
        });
        
        const uniqueVariants = new Set(items.map(i => i.internal_id));
        
        const warehouseLabelNoSearch = warehouseFilterNoSearch ? ` - ${args.warehouse}` : "";
        let output = `**Giacenze in Magazzino${warehouseLabelNoSearch}**\n`;
        output += `- **${items.length} lotti** in **${uniqueVariants.size} prodotti**\n`;
        output += `- **Totale Disponibile: ${totalAvailable.toFixed(2)}** | Riservato: ${totalReserved.toFixed(2)} | Pianificato: ${totalPlanned.toFixed(2)}\n\n`;
        
        output += `| Prodotto (Codice) | Lotto | Disponibile | Riservato | Pianificato | Magazzino | UOM |\n`;
        output += `|-------------------|-------|-------------|-----------|-------------|-----------|-----|\n`;
        
        for (const item of items.slice(0, 30)) {
          const lot = item.external_lot || item.lot || "-";
          const warehouse = item.warehouse_attr?.name || "N/A";
          output += `| ${item.internal_id} | ${lot} | ${(item.buckets?.available || 0).toFixed(2)} | ${(item.buckets?.reserved || 0).toFixed(2)} | ${(item.buckets?.planned || 0).toFixed(2)} | ${warehouse} | ${item.uom} |\n`;
        }
        
        if (items.length > 30) {
          output += `\n_Mostrati 30 di ${items.length} lotti. Cerca un prodotto specifico per filtrare._`;
        }
        return output;
      }
      
      case "product_stock": {
        const args = operation.arguments as { product_id?: string; search?: string };
        
        // Find product ID from search term if not provided directly
        let productId = args.product_id;
        let productInternalId = "";
        
        if (!productId && args.search) {
          // Search for the product by name/code
          const searchResult = await arkeService.listProducts({ search: args.search, limit: 10 });
          if (!searchResult.success) return `Errore nella ricerca prodotto: ${searchResult.error}`;
          
          const products = searchResult.data as Array<{ id: string; internal_id: string; name: string }>;
          if (!products || products.length === 0) {
            return `Nessun prodotto trovato per "${args.search}".`;
          }
          
          // Find exact match or first match
          const exactMatch = products.find(p => 
            p.internal_id.toLowerCase() === args.search!.toLowerCase()
          );
          const product = exactMatch || products[0];
          productId = product.id;
          productInternalId = product.internal_id;
        }
        
        if (!productId) return "Specificare un prodotto da cercare (es. 'PARSLEY 12 - 0190').";
        
        // Get inventory items (lots) for this product
        const invResult = await arkeService.listProductInventory(productId);
        if (!invResult.success) return `Errore: ${invResult.error}`;
        
        const items = invResult.data as Array<{
          id: string;
          name: string;
          internal_id: string;
          lot?: string;
          external_lot?: string;
          warehouse_attr?: { name: string };
          buckets?: { available?: number; reserved?: number; in_production?: number; planned?: number; shipped?: number; discarded?: number };
          uom: string;
        }>;
        
        if (!items || items.length === 0) {
          return `Nessun lotto inventario trovato per "${productInternalId || args.search}". Il prodotto esiste nel catalogo ma non ha giacenze registrate.`;
        }
        
        const productName = items[0]?.internal_id || productInternalId || "Prodotto";
        let output = `**Suddivisione Lotti per: ${productName}**\n`;
        output += `- ${items.length} lotti trovati\n\n`;
        
        output += `| Lotto Interno | Lotto Fornitore | Magazzino | Disponibile | Riservato | Scartato | UOM |\n`;
        output += `|---------------|-----------------|-----------|-------------|-----------|----------|-----|\n`;
        
        let totalAvailable = 0, totalReserved = 0, totalDiscarded = 0;
        items.forEach(item => {
          const lotInternal = item.lot || "-";
          const lotExternal = item.external_lot || "-";
          const warehouse = item.warehouse_attr?.name || "N/A";
          const avail = item.buckets?.available || 0;
          const res = item.buckets?.reserved || 0;
          const discarded = item.buckets?.discarded || 0;
          totalAvailable += avail;
          totalReserved += res;
          totalDiscarded += discarded;
          output += `| ${lotInternal} | ${lotExternal} | ${warehouse} | ${avail.toFixed(2)} | ${res.toFixed(2)} | ${discarded.toFixed(2)} | ${item.uom} |\n`;
        });
        
        output += `\n**TOTALE**: Disponibile: ${totalAvailable.toFixed(2)} kg | Riservato: ${totalReserved.toFixed(2)} kg`;
        if (totalDiscarded > 0) output += ` | Scartato: ${totalDiscarded.toFixed(2)} kg`;
        return output;
      }
      
      case "inventory_movements": {
        const args = operation.arguments as { limit?: number };
        const result = await arkeService.listInventoryEvents({ limit: args.limit || 20 });
        if (!result.success) return `Errore: ${result.error}`;
        const events = result.data as Array<{
          id: string;
          product_name: string;
          product_internal_id: string;
          quantity: number;
          from_bucket: string;
          to_bucket: string;
          time: string;
          reason_type?: string;
          reason_description?: string;
          inventory_item?: { warehouse_attr?: { name: string } };
        }>;
        if (!events || events.length === 0) return `Nessun movimento inventario recente.`;
        
        let output = `**Ultimi Movimenti Inventario** (${events.length})\n\n`;
        output += `| Data | Prodotto | Quantità | Da → A | Magazzino | Motivo |\n`;
        output += `|------|----------|----------|--------|-----------|--------|\n`;
        
        events.forEach(e => {
          const date = e.time?.split("T")[0] || "N/A";
          const fromTo = `${e.from_bucket || "-"} → ${e.to_bucket || "-"}`;
          const warehouse = e.inventory_item?.warehouse_attr?.name || "N/A";
          const reason = e.reason_description || e.reason_type || "-";
          output += `| ${date} | ${e.product_name} | ${e.quantity} | ${fromTo} | ${warehouse} | ${reason} |\n`;
        });
        return output;
      }
      
      case "low_stock_products": {
        const args = operation.arguments as { threshold?: number; limit?: number };
        const threshold = args.threshold || 10;
        const limit = args.limit || 20;
        
        // Get all inventory items
        const allLowStockInv = await arkeService.fetchAllInventoryItems();
        const items = allLowStockInv as Array<{
          id: string;
          name: string;
          internal_id: string;
          product_id: string;
          buckets?: { available?: number };
          uom: string;
          warehouse_attr?: { name: string };
        }>;
        if (!items || items.length === 0) return `Nessun dato inventario disponibile.`;
        
        // Aggregate by product and filter low stock
        const productStock: Map<string, { name: string; code: string; total: number; uom: string }> = new Map();
        
        items.forEach(item => {
          const key = item.product_id || item.internal_id;
          const available = item.buckets?.available || 0;
          
          if (!productStock.has(key)) {
            productStock.set(key, { name: item.name, code: item.internal_id, total: 0, uom: item.uom });
          }
          productStock.get(key)!.total += available;
        });
        
        // Filter and sort by stock level
        const lowStock = Array.from(productStock.values())
          .filter(p => p.total <= threshold)
          .sort((a, b) => a.total - b.total)
          .slice(0, limit);
        
        if (lowStock.length === 0) {
          return `Nessun prodotto con giacenza inferiore a ${threshold}.`;
        }
        
        let output = `**Prodotti con Giacenza Bassa** (soglia: ${threshold})\n\n`;
        output += `| # | Prodotto | Codice | Disponibile | UOM |\n`;
        output += `|---|----------|--------|-------------|-----|\n`;
        
        lowStock.forEach((p, i) => {
          const warning = p.total === 0 ? " ⚠️" : "";
          output += `| ${i + 1} | ${p.name}${warning} | ${p.code} | ${p.total.toFixed(2)} | ${p.uom} |\n`;
        });
        
        return output;
      }
      
      default:
        return `Operazione non supportata: ${operation.name}`;
    }
  } catch (error) {
    console.error("Magazzino operation error:", error);
    return `Errore nell'esecuzione: ${error instanceof Error ? error.message : "Errore sconosciuto"}`;
  }
}

// Helper: Filter orders by date range
function filterOrdersByDate<T extends { expected_shipping_time?: string; created_at?: string }>(
  orders: T[],
  dateFrom?: string,
  dateTo?: string
): T[] {
  if (!dateFrom && !dateTo) return orders;
  
  return orders.filter(order => {
    // Use expected_shipping_time or created_at as the order date
    const orderDateStr = order.expected_shipping_time || order.created_at;
    if (!orderDateStr) return false;
    
    const orderDate = new Date(orderDateStr);
    
    if (dateFrom) {
      const fromDate = new Date(dateFrom);
      if (orderDate < fromDate) return false;
    }
    
    if (dateTo) {
      const toDate = new Date(dateTo);
      // Include the entire end date day
      toDate.setHours(23, 59, 59, 999);
      if (orderDate > toDate) return false;
    }
    
    return true;
  });
}

// Helper: Format date range for output
function formatDateRange(dateFrom?: string, dateTo?: string): string {
  if (!dateFrom && !dateTo) return "";
  if (dateFrom && dateTo) return ` (dal ${dateFrom} al ${dateTo})`;
  if (dateFrom) return ` (dal ${dateFrom})`;
  if (dateTo) return ` (fino al ${dateTo})`;
  return "";
}

async function executeAnalisiVenditeOperation(operation: ArkeToolCall): Promise<string> {
  try {
    console.log(`[TOOL CALL - ANALISI VENDITE] ${operation.name} con Argomenti: ${JSON.stringify(operation.arguments)}`);
    
    switch (operation.name) {
      case "sales_search_customer": {
        const args = operation.arguments as { search: string };
        const result = await arkeService.listCustomers({ search: args.search, limit: 10 });
        if (!result.success) return `Errore: ${result.error}`;
        const customers = result.data as Array<{id: string; name: string; addresses?: Array<{country?: string; address?: string}>}>;
        if (!customers || customers.length === 0) return `Nessun cliente trovato per "${args.search}".`;
        let output = `Trovati ${customers.length} clienti:\n\n`;
        customers.forEach((c, i) => {
          const addr = c.addresses?.[0];
          const location = addr?.country || addr?.address || "";
          output += `${i + 1}. **${c.name}**${location ? ` (${location})` : ""}\n`;
          output += `   ID: \`${c.id}\`\n\n`;
        });
        output += `\nUsa **sales_by_customer** con l'ID per vedere gli ordini di un cliente.`;
        return output;
      }
      
      case "sales_by_customer": {
        const args = operation.arguments as { customer_id: string; limit?: number; date_from?: string; date_to?: string };
        
        // First get the customer name for filtering
        const customerResult = await arkeService.getCustomer(args.customer_id);
        if (!customerResult.success) return `Errore: ${customerResult.error}`;
        const customerData = customerResult.data as { id: string; name: string };
        const targetCustomerName = customerData.name?.toLowerCase() || '';
        
        // Get all orders (API doesn't support customer_id filter reliably)
        const result = await arkeService.listSalesOrders({ limit: 200 });
        if (!result.success) return `Errore: ${result.error}`;
        let orders = result.data as Array<{id: string; internal_id?: string; status: string; expected_shipping_time: string; total_vat_incl: number; customer_attr?: {name: string; id?: string}}>;
        
        // Filter by customer name (case-insensitive exact match)
        orders = orders.filter(o => {
          const orderCustomerName = o.customer_attr?.name?.toLowerCase() || '';
          const orderCustomerId = o.customer_attr?.id || '';
          return orderCustomerName === targetCustomerName || orderCustomerId === args.customer_id;
        });
        
        // Apply date filter
        orders = filterOrdersByDate(orders, args.date_from, args.date_to);
        if (!orders || orders.length === 0) return `Nessun ordine trovato per ${customerData.name}${formatDateRange(args.date_from, args.date_to)}.`;
        
        // Apply limit after filtering
        const limitedOrders = orders.slice(0, args.limit || 20);
        
        let total = 0;
        orders.forEach(o => { total += o.total_vat_incl || 0; });
        
        let output = `**Ordini di ${customerData.name}${formatDateRange(args.date_from, args.date_to)}** (${orders.length} trovati):\n\n`;
        output += `| # | Ordine | Stato | Data Spedizione | Totale |\n`;
        output += `|---|--------|-------|-----------------|--------|\n`;
        limitedOrders.forEach((o, i) => {
          const date = o.expected_shipping_time?.split("T")[0] || "N/A";
          output += `| ${i + 1} | ${o.internal_id || o.id} | ${o.status.toUpperCase()} | ${date} | ${o.total_vat_incl?.toFixed(2) || 0} EUR |\n`;
        });
        output += `\n**Totale ordini: ${total.toFixed(2)} EUR**`;
        return output;
      }
      
      case "sales_summary": {
        const result = await arkeService.getLastTwoMonthSales();
        if (!result.success) return `Errore: ${result.error}`;
        const sales = result.data as Array<{month: string; order_count: number; total: number}>;
        if (!sales || sales.length === 0) return `Nessun dato vendite disponibile.`;
        
        let output = `**Riepilogo Vendite Ultimi 2 Mesi**\n\n`;
        let grandTotal = 0;
        let totalOrders = 0;
        sales.forEach(s => {
          output += `**${s.month}**: ${s.order_count} ordini - ${s.total?.toFixed(2) || 0} EUR\n`;
          grandTotal += s.total || 0;
          totalOrders += s.order_count;
        });
        output += `\n**TOTALE**: ${totalOrders} ordini - ${grandTotal.toFixed(2)} EUR`;
        return output;
      }
      
      case "active_orders": {
        const args = operation.arguments as { limit?: number };
        const result = await arkeService.listActiveOrders({ limit: args.limit || 20 });
        if (!result.success) return `Errore: ${result.error}`;
        const orders = result.data as Array<{id: string; internal_id?: string; status: string; expected_shipping_time: string; total_vat_incl: number; customer_attr?: {name: string}; products?: Array<{name: string; quantity: number}>}>;
        if (!orders || orders.length === 0) return `Nessun ordine attivo al momento.`;
        
        let output = `**Ordini Attivi** (${orders.length}):\n\n`;
        orders.forEach((o, i) => {
          const date = o.expected_shipping_time?.split("T")[0] || "N/A";
          const customer = o.customer_attr?.name || "N/A";
          const productCount = o.products?.length || 0;
          output += `${i + 1}. **${o.internal_id || o.id}** - ${customer}\n`;
          output += `   Stato: ${o.status} | Data: ${date} | Prodotti: ${productCount} | Totale: ${o.total_vat_incl?.toFixed(2) || 0} EUR\n\n`;
        });
        return output;
      }
      
      case "order_details": {
        const args = operation.arguments as { order_id: string };
        const result = await arkeService.getSalesOrder(args.order_id);
        if (!result.success) return `Errore: ${result.error}`;
        const order = result.data as {id: string; internal_id?: string; status: string; expected_shipping_time: string; shipping_address: string; total: number; customer_attr?: {name: string; address?: string}; products?: Array<{name: string; quantity: number; uom: string; prices?: {unit: number}}>};
        if (!order) return `Ordine non trovato: ${args.order_id}`;
        
        let output = `**Dettagli Ordine ${order.internal_id || order.id}**\n\n`;
        output += `**Cliente**: ${order.customer_attr?.name || "N/A"}\n`;
        output += `**Stato**: ${order.status}\n`;
        output += `**Data Spedizione**: ${order.expected_shipping_time?.split("T")[0] || "N/A"}\n`;
        output += `**Indirizzo**: ${order.shipping_address || "N/A"}\n\n`;
        
        if (order.products && order.products.length > 0) {
          output += `**Prodotti** (${order.products.length}):\n`;
          order.products.forEach((p, i) => {
            const price = p.prices?.unit || 0;
            const lineTotal = price * p.quantity;
            output += `${i + 1}. ${p.name} - ${p.quantity} ${p.uom} @ ${price.toFixed(2)} EUR = ${lineTotal.toFixed(2)} EUR\n`;
          });
        }
        output += `\n**Totale Ordine**: ${order.total?.toFixed(2) || 0} EUR`;
        return output;
      }
      
      case "all_orders": {
        const args = operation.arguments as { customer?: string; product?: string; status?: string; limit?: number; date_from?: string; date_to?: string };
        const result = await arkeService.listSalesOrders({ status: args.status, limit: 200 });
        if (!result.success) return `Errore: ${result.error}`;
        let orders = result.data as Array<{id: string; internal_id?: string; status: string; expected_shipping_time: string; total_vat_incl: number; customer_attr?: {name: string}; products?: Array<{name: string; extra_id?: string; quantity: number; uom: string}>}>;
        
        // Apply date filter
        orders = filterOrdersByDate(orders, args.date_from, args.date_to);
        const dateNote = formatDateRange(args.date_from, args.date_to);
        
        // Apply customer filter (case-insensitive match on customer name)
        const customerFilter = args.customer?.toLowerCase();
        if (customerFilter) {
          orders = orders.filter(o => {
            const customerName = o.customer_attr?.name?.toLowerCase() || '';
            return customerName.includes(customerFilter);
          });
        }
        
        // Apply product filter - requires fetching order details
        const productFilter = args.product?.toLowerCase();
        if (productFilter) {
          // Normalize filter: remove dashes and extra spaces for fuzzy matching
          const normalizeString = (s: string) => s.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
          const normalizedFilter = normalizeString(productFilter);
          
          const matchingOrders: typeof orders = [];
          for (const order of orders) {
            // Fetch order details to get products
            const detailResult = await arkeService.getSalesOrder(order.id);
            if (detailResult.success && detailResult.data) {
              const orderDetail = detailResult.data as { products?: Array<{name: string; extra_id?: string; quantity: number; uom: string}> };
              const products = orderDetail.products || [];
              // Check if any product matches the filter (fuzzy match)
              const hasMatch = products.some(p => {
                const code = normalizeString(p.extra_id || p.name || '');
                const name = normalizeString(p.name || '');
                return code.includes(normalizedFilter) || name.includes(normalizedFilter);
              });
              if (hasMatch) {
                // Store products in order for later display
                (order as any).matchedProducts = products.filter(p => {
                  const code = normalizeString(p.extra_id || p.name || '');
                  const name = normalizeString(p.name || '');
                  return code.includes(normalizedFilter) || name.includes(normalizedFilter);
                });
                matchingOrders.push(order);
              }
            }
          }
          orders = matchingOrders;
        }
        
        // Build filter description
        const filters: string[] = [];
        if (customerFilter) filters.push(`cliente: "${args.customer}"`);
        if (productFilter) filters.push(`prodotto: "${args.product}"`);
        if (args.status) filters.push(`stato: ${args.status}`);
        const filterNote = filters.length > 0 ? ` (${filters.join(', ')})` : '';
        
        if (!orders || orders.length === 0) return `Nessun ordine trovato${filterNote}${dateNote}.`;
        
        // Apply limit after filtering
        const limitedOrders = orders.slice(0, args.limit || 50);
        
        let output = `**Ordini trovati**${filterNote}${dateNote} - ${orders.length} risultati:\n\n`;
        
        // Table header
        output += `| # | Ordine | Cliente | Data | Stato | Totale |${productFilter ? ' Prodotto Trovato | Qty |' : ''}\n`;
        output += `|---|--------|---------|------|-------|--------|${productFilter ? '------------------|-----|' : ''}\n`;
        
        for (let i = 0; i < limitedOrders.length; i++) {
          const o = limitedOrders[i];
          const date = o.expected_shipping_time?.split("T")[0] || "N/A";
          const customer = o.customer_attr?.name || "N/A";
          const total = o.total_vat_incl?.toFixed(2) || "0.00";
          
          if (productFilter && (o as any).matchedProducts) {
            // Show each matched product as a row
            for (const p of (o as any).matchedProducts) {
              const code = p.extra_id || p.name;
              output += `| ${i + 1} | ${o.internal_id || o.id} | ${customer} | ${date} | ${o.status} | ${total} EUR | ${code} | ${p.quantity} ${p.uom} |\n`;
            }
          } else {
            output += `| ${i + 1} | ${o.internal_id || o.id} | ${customer} | ${date} | ${o.status} | ${total} EUR |\n`;
          }
        }
        
        return output;
      }
      
      case "top_products": {
        const args = operation.arguments as { limit?: number; filter?: string; date_from?: string; date_to?: string };
        // When filter is used, default to showing more results (50) since user wants all matching products
        const topLimit = args.limit || (args.filter ? 50 : 10);
        const filterCode = args.filter?.toLowerCase();
        const dateNote = formatDateRange(args.date_from, args.date_to);
        
        // Get orders (more to allow date filtering)
        const ordersResult = await arkeService.listSalesOrders({ limit: 200 });
        if (!ordersResult.success) return `Errore: ${ordersResult.error}`;
        let orders = ordersResult.data as Array<{id: string; expected_shipping_time?: string; products?: Array<{name: string; extra_id?: string; quantity: number; uom: string}>}>;
        
        // Apply date filter
        orders = filterOrdersByDate(orders, args.date_from, args.date_to);
        if (!orders || orders.length === 0) return `Nessun ordine trovato per analizzare i prodotti${dateNote}.`;
        
        // Aggregate products across all orders
        const productStats: Map<string, { name: string; code: string; totalQty: number; uom: string; orderCount: number }> = new Map();
        
        let ordersWithProducts = 0;
        for (const order of orders) {
          // If order doesn't have products inline, fetch details
          let products = order.products;
          if (!products || products.length === 0) {
            const detailResult = await arkeService.getSalesOrder(order.id);
            if (detailResult.success && detailResult.data) {
              const orderDetail = detailResult.data as { products?: Array<{name: string; extra_id?: string; quantity: number; uom: string}> };
              products = orderDetail.products;
            }
          }
          
          if (products && products.length > 0) {
            ordersWithProducts++;
            for (const p of products) {
              const code = p.extra_id || p.name;
              
              // Apply filter on CODE only (not name) if specified
              if (filterCode && !code.toLowerCase().includes(filterCode)) {
                continue; // Skip products that don't match filter
              }
              
              const existing = productStats.get(code);
              if (existing) {
                existing.totalQty += p.quantity;
                existing.orderCount++;
              } else {
                productStats.set(code, {
                  name: p.name,
                  code: code,
                  totalQty: p.quantity,
                  uom: p.uom || "kg",
                  orderCount: 1
                });
              }
            }
          }
        }
        
        if (productStats.size === 0) {
          if (filterCode) {
            return `Nessun prodotto con "${args.filter}" nel codice trovato negli ordini.`;
          }
          return `Nessun prodotto trovato negli ordini analizzati.`;
        }
        
        // Sort by total quantity descending
        const sorted = Array.from(productStats.entries())
          .sort((a, b) => b[1].totalQty - a[1].totalQty)
          .slice(0, topLimit);
        
        const filterNote = filterCode ? ` (filtro: "${args.filter}")` : "";
        let output = `**Top ${sorted.length} Prodotti Più Venduti${filterNote}${dateNote}**\n`;
        output += `(Analisi su ${ordersWithProducts} ordini)\n\n`;
        
        output += `| # | Codice Prodotto | Quantità | Nr. Ordini |\n`;
        output += `|---|-----------------|----------|------------|\n`;
        
        sorted.forEach(([code, stats], i) => {
          output += `| ${i + 1} | ${code} | ${stats.totalQty.toFixed(2)} ${stats.uom} | ${stats.orderCount} |\n`;
        });
        
        return output;
      }
      
      case "top_products_by_customer": {
        const args = operation.arguments as { limit?: number; date_from?: string; date_to?: string };
        const customerLimit = args.limit || 20;
        const dateNote = formatDateRange(args.date_from, args.date_to);
        
        // Get orders (more to allow date filtering)
        const ordersResult = await arkeService.listSalesOrders({ limit: 200 });
        if (!ordersResult.success) return `Errore: ${ordersResult.error}`;
        let orders = ordersResult.data as Array<{id: string; expected_shipping_time?: string; customer_id?: string; customer_attr?: {name: string}; products?: Array<{name: string; extra_id?: string; quantity: number; uom: string}>}>;
        
        // Apply date filter
        orders = filterOrdersByDate(orders, args.date_from, args.date_to);
        if (!orders || orders.length === 0) return `Nessun ordine trovato per analizzare${dateNote}.`;
        
        // Structure: customerId -> { customerName, products: Map<productCode, {name, qty, uom}> }
        const customerProducts: Map<string, { 
          customerName: string; 
          products: Map<string, { name: string; totalQty: number; uom: string }> 
        }> = new Map();
        
        for (const order of orders) {
          const customerId = order.customer_id || order.customer_attr?.name || "Unknown";
          const customerName = order.customer_attr?.name || customerId;
          
          // Get products - fetch details if not inline
          let products = order.products;
          if (!products || products.length === 0) {
            const detailResult = await arkeService.getSalesOrder(order.id);
            if (detailResult.success && detailResult.data) {
              const orderDetail = detailResult.data as { products?: Array<{name: string; extra_id?: string; quantity: number; uom: string}> };
              products = orderDetail.products;
            }
          }
          
          if (products && products.length > 0) {
            if (!customerProducts.has(customerId)) {
              customerProducts.set(customerId, { customerName, products: new Map() });
            }
            const customerData = customerProducts.get(customerId)!;
            
            for (const p of products) {
              const productKey = p.extra_id || p.name;
              const existing = customerData.products.get(productKey);
              if (existing) {
                existing.totalQty += p.quantity;
              } else {
                customerData.products.set(productKey, {
                  name: p.name,
                  totalQty: p.quantity,
                  uom: p.uom || "kg"
                });
              }
            }
          }
        }
        
        if (customerProducts.size === 0) {
          return `Nessun dato prodotti trovato negli ordini.`;
        }
        
        // For each customer, find their top product
        const results: Array<{ customerName: string; topProduct: string; productCode: string; qty: number; uom: string }> = [];
        
        Array.from(customerProducts.entries()).forEach(([, data]) => {
          let topProduct = { name: "", code: "", qty: 0, uom: "kg" };
          Array.from(data.products.entries()).forEach(([code, product]) => {
            if (product.totalQty > topProduct.qty) {
              topProduct = { name: product.name, code, qty: product.totalQty, uom: product.uom };
            }
          });
          if (topProduct.name) {
            results.push({
              customerName: data.customerName,
              topProduct: topProduct.name,
              productCode: topProduct.code,
              qty: topProduct.qty,
              uom: topProduct.uom
            });
          }
        });
        
        // Sort by quantity descending and limit
        results.sort((a, b) => b.qty - a.qty);
        const limited = results.slice(0, customerLimit);
        
        let output = `**Prodotto Più Venduto per Cliente${dateNote}**\n`;
        output += `(Analisi su ${customerProducts.size} clienti)\n\n`;
        output += `| Cliente | Prodotto Preferito | Codice | Quantità |\n`;
        output += `|---------|-------------------|--------|----------|\n`;
        
        for (const r of limited) {
          output += `| ${r.customerName} | ${r.topProduct} | ${r.productCode} | ${r.qty.toFixed(2)} ${r.uom} |\n`;
        }
        
        return output;
      }
      
      case "sales_by_country": {
        const args = operation.arguments as { date_from?: string; date_to?: string };
        const dateNote = formatDateRange(args.date_from, args.date_to);
        
        // Get orders (more to allow date filtering)
        const ordersResult = await arkeService.listSalesOrders({ limit: 200 });
        if (!ordersResult.success) return `Errore: ${ordersResult.error}`;
        let orders = ordersResult.data as Array<{
          id: string;
          expected_shipping_time?: string;
          customer_id?: string;
          customer_attr?: { name: string; country?: string; address?: string };
          total_vat_incl?: number;
          total?: number;
        }>;
        
        // Apply date filter
        orders = filterOrdersByDate(orders, args.date_from, args.date_to);
        if (!orders || orders.length === 0) return `Nessun ordine trovato${dateNote}.`;
        
        // Aggregate by country
        const countryStats: Map<string, { orderCount: number; totalAmount: number; customers: Set<string> }> = new Map();
        
        for (const order of orders) {
          // Try to get country from customer_attr
          let country = order.customer_attr?.country;
          
          // If no country in order, try to fetch customer details
          if (!country && order.customer_id) {
            const customerResult = await arkeService.getCustomer(order.customer_id);
            if (customerResult.success && customerResult.data) {
              const customer = customerResult.data as { country?: string; addresses?: Array<{ country?: string }> };
              country = customer.country || customer.addresses?.[0]?.country;
            }
          }
          
          // Extract country from address if still not found
          if (!country && order.customer_attr?.address) {
            // Try to extract country code from address (usually at the end like "- IT" or "- US")
            const addressMatch = order.customer_attr.address.match(/[-–]\s*([A-Z]{2})\s*$/);
            if (addressMatch) {
              country = addressMatch[1];
            }
          }
          
          const countryKey = country || "Non specificato";
          const orderTotal = order.total_vat_incl || order.total || 0;
          const customerName = order.customer_attr?.name || order.customer_id || "Unknown";
          
          if (!countryStats.has(countryKey)) {
            countryStats.set(countryKey, { orderCount: 0, totalAmount: 0, customers: new Set() });
          }
          const stats = countryStats.get(countryKey)!;
          stats.orderCount++;
          stats.totalAmount += orderTotal;
          stats.customers.add(customerName);
        }
        
        if (countryStats.size === 0) {
          return `Nessun dato paese trovato negli ordini.`;
        }
        
        // Sort by total amount descending
        const sorted = Array.from(countryStats.entries())
          .sort((a, b) => b[1].totalAmount - a[1].totalAmount);
        
        let grandTotal = 0;
        sorted.forEach(([, s]) => { grandTotal += s.totalAmount; });
        
        let output = `**Vendite per Paese/Nazionalità${dateNote}**\n`;
        output += `(Analisi su ${orders.length} ordini)\n\n`;
        output += `| Paese | N. Ordini | N. Clienti | Totale Venduto | % |\n`;
        output += `|-------|-----------|------------|----------------|---|\n`;
        
        sorted.forEach(([country, stats]) => {
          const percentage = grandTotal > 0 ? ((stats.totalAmount / grandTotal) * 100).toFixed(1) : "0";
          output += `| ${country} | ${stats.orderCount} | ${stats.customers.size} | ${stats.totalAmount.toFixed(2)} EUR | ${percentage}% |\n`;
        });
        
        output += `\n**TOTALE: ${grandTotal.toFixed(2)} EUR**`;
        return output;
      }
      
      case "orders_by_agent": {
        const args = operation.arguments as { agent_name: string; limit?: number; date_from?: string; date_to?: string };
        const dateNote = formatDateRange(args.date_from, args.date_to);
        
        // Get list of orders (more for filtering)
        const ordersResult = await arkeService.listSalesOrders({ limit: 200 });
        if (!ordersResult.success) return `Errore: ${ordersResult.error}`;
        let orderSummaries = ordersResult.data as Array<{
          id: string;
          internal_id?: string;
          status: string;
          expected_shipping_time?: string;
          total_vat_incl?: number;
          customer_attr?: { name: string };
        }>;
        
        // Apply date filter
        orderSummaries = filterOrdersByDate(orderSummaries, args.date_from, args.date_to);
        if (!orderSummaries || orderSummaries.length === 0) return `Nessun ordine trovato${dateNote}.`;
        
        // Fetch full details for each order to get agent info
        const searchLower = args.agent_name.toLowerCase();
        const agentOrders: Array<{
          internal_id: string;
          customer: string;
          date: string;
          status: string;
          total: number;
          agentName: string;
        }> = [];
        
        for (const summary of orderSummaries) {
          if (!summary.id) continue;
          const detailResult = await arkeService.getSalesOrder(summary.id);
          if (!detailResult.success) continue;
          const detail = detailResult.data as {
            id: string;
            internal_id?: string;
            status: string;
            expected_shipping_time?: string;
            total?: number;
            total_vat_incl?: number;
            agent?: { full_name: string; id: string; username: string };
            customer_attr?: { name: string };
          };
          
          // Check if agent matches search
          const agentName = detail.agent?.full_name || "";
          const agentUsername = detail.agent?.username || "";
          if (agentName.toLowerCase().includes(searchLower) || agentUsername.toLowerCase().includes(searchLower)) {
            agentOrders.push({
              internal_id: detail.internal_id || detail.id,
              customer: detail.customer_attr?.name || "N/A",
              date: detail.expected_shipping_time?.split("T")[0] || "N/A",
              status: detail.status,
              total: detail.total_vat_incl || detail.total || 0,
              agentName: agentName
            });
          }
        }
        
        if (agentOrders.length === 0) {
          return `Nessun ordine trovato per l'agente "${args.agent_name}"${dateNote}.`;
        }
        
        let totalAmount = 0;
        let output = `**Ordini dell'Agente "${agentOrders[0]?.agentName || args.agent_name}"${dateNote}** (${agentOrders.length} ordini)\n\n`;
        output += `| # | Ordine | Cliente | Data | Stato | Totale |\n`;
        output += `|---|--------|---------|------|-------|--------|\n`;
        
        agentOrders.forEach((o, i) => {
          totalAmount += o.total;
          output += `| ${i + 1} | ${o.internal_id} | ${o.customer} | ${o.date} | ${o.status} | ${o.total.toFixed(2)} EUR |\n`;
        });
        
        output += `\n**TOTALE VENDITE AGENTE: ${totalAmount.toFixed(2)} EUR**`;
        return output;
      }
      
      case "agent_ranking": {
        const args = operation.arguments as { limit?: number; date_from?: string; date_to?: string };
        const topLimit = args.limit || 10;
        const dateNote = formatDateRange(args.date_from, args.date_to);
        
        // Get list of orders (more for filtering)
        const ordersResult = await arkeService.listSalesOrders({ limit: 200 });
        if (!ordersResult.success) return `Errore: ${ordersResult.error}`;
        let orderSummaries = ordersResult.data as Array<{
          id: string;
          expected_shipping_time?: string;
          total_vat_incl?: number;
        }>;
        
        // Apply date filter
        orderSummaries = filterOrdersByDate(orderSummaries, args.date_from, args.date_to);
        if (!orderSummaries || orderSummaries.length === 0) return `Nessun ordine trovato${dateNote}.`;
        
        // Fetch full details for each order to get agent info
        const agentStats: Map<string, { name: string; orderCount: number; totalAmount: number }> = new Map();
        let processedCount = 0;
        
        for (const summary of orderSummaries) {
          if (!summary.id) continue;
          const detailResult = await arkeService.getSalesOrder(summary.id);
          if (!detailResult.success) continue;
          const detail = detailResult.data as {
            total?: number;
            total_vat_incl?: number;
            agent?: { full_name: string; id: string; username: string };
          };
          
          processedCount++;
          const agentName = detail.agent?.full_name || "Non assegnato";
          const orderTotal = detail.total_vat_incl || detail.total || summary.total_vat_incl || 0;
          
          if (!agentStats.has(agentName)) {
            agentStats.set(agentName, { name: agentName, orderCount: 0, totalAmount: 0 });
          }
          const stats = agentStats.get(agentName)!;
          stats.orderCount++;
          stats.totalAmount += orderTotal;
        }
        
        if (agentStats.size === 0) {
          return `Nessun dato agente trovato negli ordini.`;
        }
        
        // Sort by order count descending
        const sorted = Array.from(agentStats.values())
          .sort((a, b) => b.orderCount - a.orderCount)
          .slice(0, topLimit);
        
        let grandTotal = 0;
        sorted.forEach(s => { grandTotal += s.totalAmount; });
        
        let output = `**Classifica Agenti Commerciali${dateNote}**\n`;
        output += `(Analisi su ${processedCount} ordini)\n\n`;
        output += `| Pos | Agente | N. Ordini | Totale Venduto | Media/Ordine |\n`;
        output += `|-----|--------|-----------|----------------|---------------|\n`;
        
        sorted.forEach((s, i) => {
          const avgOrder = s.orderCount > 0 ? s.totalAmount / s.orderCount : 0;
          output += `| ${i + 1} | ${s.name} | ${s.orderCount} | ${s.totalAmount.toFixed(2)} EUR | ${avgOrder.toFixed(2)} EUR |\n`;
        });
        
        output += `\n**TOTALE COMPLESSIVO: ${grandTotal.toFixed(2)} EUR**`;
        return output;
      }
      
      default:
        return `Operazione non supportata: ${operation.name}`;
    }
  } catch (error) {
    console.error("Analisi Vendite operation error:", error);
    return `Errore nell'esecuzione: ${error instanceof Error ? error.message : "Errore sconosciuto"}`;
  }
}

async function seedAgents() {
  try {
    const existing = await db.select({ id: agents.id }).from(agents);
    if (existing.length > 0) return;

    console.log("Seeding default agents...");
    await db.insert(agents).values([
      {
        name: "Crea Ordine Vendita",
        description: "Guida rapida alla creazione di un ordine di vendita",
        icon: "ShoppingCart",
        category: "Vendite",
        systemPrompt: `RUOLO: Wizard di Ferro per ordini vendita Arke.
DATA: 21 Gennaio 2026

=== SEQUENZA OBBLIGATORIA (BLOCCANTE) ===
Step 1: CLIENTE → Solo search_customer e draft_set_customer permessi
Step 2: INDIRIZZO → Solo set_shipping_address permesso  
Step 3: PRODOTTI → search_product, draft_add_item, draft_remove_item permessi
Step 4: CONFERMA → submit_order permesso

NON puoi saltare step. Se il cliente manca, RIFIUTA qualsiasi richiesta prodotti.

=== FORMATO RISPOSTA OBBLIGATORIO ===
OGNI risposta DEVE iniziare con lo STATO DB letto in tempo reale:

--- STATO DB ---
Cliente: [nome o MANCANTE]
Indirizzo: [indirizzo o MANCANTE]
Articoli: [numero]
-----------------

[Il tuo messaggio qui]

=== DIVIETO ASSOLUTO DI ALLUCINAZIONE ===
NON scrivere MAI:
- "Ho impostato..." senza aver chiamato il tool
- "Indirizzo confermato..." senza set_shipping_address  
- "Prodotto aggiunto..." senza draft_add_item

Se un tool FALLISCE, scrivi ESATTAMENTE:
"ERRORE TECNICO: [descrizione errore dal tool]"

Solo se il tool restituisce SUCCESSO puoi confermare l'azione.

=== WORKFLOW STEP-BY-STEP ===

**STEP 1 - CLIENTE**
- Chiedi nome cliente se non fornito
- Chiama search_customer
- Mostra risultati, chiedi conferma
- Chiama draft_set_customer con UUID
- Avanza automaticamente a STEP 2

**STEP 2 - INDIRIZZO**
- Mostra lista indirizzi del cliente
- Chiedi quale usare (numero o testo)
- Chiama set_shipping_address
- Avanza automaticamente a STEP 3

**STEP 3 - PRODOTTI**
- Permetti ricerca prodotti
- Chiama draft_add_item per ogni prodotto
- Permetti rimozioni con draft_remove_item
- Quando utente dice "basta"/"conferma" → STEP 4

**STEP 4 - CONFERMA**
- Mostra riepilogo completo
- Chiedi conferma esplicita
- Chiama submit_order
- Mostra ID ordine Arke dalla risposta

=== REGOLE TECNICHE ===
- draft_add_item SOVRASCRIVE la quantità (idempotente)
- Ordini a totale €0 sono validi (campionatura)
- Usa CODICE prodotto (es. "PARSLEY 12 - RAW") per draft_add_item

Rispondi in italiano. Sii breve e preciso.`,
        tools: ["search_customer", "search_product", "draft_set_customer", "set_shipping_address", "set_shipping_date", "draft_add_item", "draft_remove_item", "draft_show_summary", "clear_session", "submit_order"],
        welcomeMessage: "Ciao! Creiamo un ordine. Per quale cliente?",
        isActive: 1,
      },
      {
        name: "Analisi Vendite",
        description: "Statistiche e report sulle vendite: ordini per cliente, prodotti più venduti, trend mensili",
        icon: "BarChart3",
        category: "Analisi",
        systemPrompt: `RUOLO: Analista Vendite Arke - Settore tessile/filati
DATA ODIERNA: 21 Gennaio 2026

=== REGOLA FONDAMENTALE ===
I PANEL e i FILATI sono DUE CATEGORIE COMPLETAMENTE DIVERSE:
- PANEL = campioni colore per showroom (venduti in UNITÀ)
- FILATI = prodotti industriali (venduti in KG)

NON MESCOLARE MAI nella stessa tabella o analisi!

=== FILTRO TEMPORALE ===
IMPORTANTE: Se l'utente menziona un periodo, DEVI passare date_from e date_to ai tool.

Esempi di conversione:
- "nel 2026" → date_from: "2026-01-01", date_to: "2026-12-31"
- "a gennaio 2026" → date_from: "2026-01-01", date_to: "2026-01-31"
- "Q1 2026" → date_from: "2026-01-01", date_to: "2026-03-31"
- "ultimo mese" → calcola dal mese precedente
- "ultimi 3 mesi" → calcola da 3 mesi fa ad oggi

Se NON c'è periodo specificato, NON passare date_from/date_to (mostra tutto).

=== CONOSCENZA DOMINIO ===
- Prodotti base: PARSLEY, SAGE, BOLD, SUZETTE con varianti colore
- PANEL = pannelli campione B2B showroom, sempre "- PANEL" nel nome
- RAW = filato greggio pre-tintura
- MELANGE = effetto mélange

=== FORMATO RISPOSTE ===
**Dati**: Mostra tabella COMPLETA, MAI abbreviare con "..."

Se richiesto prodotto generico, SEPARA:
**Vendite Filati (kg):**
| # | Prodotto | Qty | Ordini |

**Vendite PANEL (unit):**
| # | Prodotto | Qty | Ordini |

**Osservazioni**: Bullet points con - (NON numerare)

**Analisi suggerite:** (opzionale, numerate)

=== DIVIETI ===
- MAI mescolare PANEL e FILATI nella stessa tabella
- MAI sommare kg con unità
- MAI troncare tabelle
- MAI inventare dati

Italiano, tono diretto.`,
        tools: ["sales_search_customer", "sales_by_customer", "sales_summary", "active_orders", "order_details", "all_orders", "top_products", "top_products_by_customer", "sales_by_country", "orders_by_agent", "agent_ranking"],
        welcomeMessage: `Ciao! Sono qui per aiutarti ad analizzare le vendite. Cosa vuoi sapere?

Posso mostrarti:
- Ordini di un cliente specifico
- Riepilogo vendite degli ultimi mesi
- Ordini attivi in corso
- Dettagli di un ordine specifico
- Prodotti più venduti (classifica generale)
- Prodotto preferito per ogni cliente
- Vendite per nazionalità/paese del cliente
- Ordini e performance di un agente commerciale
- Classifica agenti per numero ordini e fatturato`,
        isActive: 1,
      },
      {
        name: "Gestione Magazzino",
        description: "Consulta giacenze, magazzini e movimenti inventario",
        icon: "Warehouse",
        category: "Magazzino",
        systemPrompt: `RUOLO: Warehouse Manager Arke - Settore tessile/filati
DATA: 21 Gennaio 2026

=== REGOLA FONDAMENTALE ===
I PANEL e i FILATI sono DUE CATEGORIE COMPLETAMENTE DIVERSE:
- PANEL = campioni colore showroom (in UNITÀ)
- FILATI = prodotti industriali (in KG)

NON MESCOLARE MAI nella stessa tabella!

=== CONOSCENZA DOMINIO ===
- Lotto Fornitore (external_lot): codice origine
- Lotto Interno (lot): codice Arke
- RAW = filato greggio pre-tintura
- Buckets: disponibile, riservato, pianificato, scartato

=== FORMATO RISPOSTE ===
**Dati**: Tabella COMPLETA, MAI abbreviare con "..."

Se richiesto prodotto generico, SEPARA:
**Giacenze Filati (kg):**
| Prodotto | Disponibile | Riservato |

**Giacenze PANEL (unit):**
| Prodotto | Disponibile |

**Situazione**: 1-2 frasi sintesi
**Osservazioni**: Bullet points con - (NON numerare)

=== DIVIETI ===
- MAI mescolare PANEL e FILATI
- MAI troncare tabelle
- MAI inventare dati

Italiano, tono pratico.`,
        tools: ["list_warehouses", "search_inventory", "product_stock", "inventory_movements", "low_stock_products"],
        welcomeMessage: `Ciao! Sono qui per aiutarti a gestire il magazzino. Cosa vuoi sapere?

Posso mostrarti:
- Lista dei magazzini disponibili
- Giacenze di un prodotto specifico
- Ultimi movimenti inventario
- Prodotti con scorte basse`,
        isActive: 1,
      },
    ]);
    console.log("Default agents seeded successfully.");
  } catch (error) {
    console.error("Error seeding agents:", error);
  }
}

async function seedConfiguratorData() {
  try {
    const existingFolders = await db.select({ id: colorFolders.id }).from(colorFolders);
    if (existingFolders.length > 0) return;

    console.log("Seeding configurator data...");
    const fs = await import("fs");
    const path = await import("path");
    const dir = typeof __dirname !== "undefined" ? __dirname : import.meta.dirname;
    const seedDir = path.join(dir, "seed-data");

    const foldersData = JSON.parse(fs.readFileSync(path.join(seedDir, "color-folders.json"), "utf-8"));
    const colorsData = JSON.parse(fs.readFileSync(path.join(seedDir, "colors.json"), "utf-8"));
    const masterProductsData = JSON.parse(fs.readFileSync(path.join(seedDir, "master-products.json"), "utf-8"));

    for (const f of foldersData) {
      await db.insert(colorFolders).values({
        id: f.id,
        code: f.code,
        name: f.name,
        description: f.description,
      });
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < colorsData.length; i += BATCH_SIZE) {
      const batch = colorsData.slice(i, i + BATCH_SIZE).map((c: any) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        folderId: c.folder_id,
        stockTiers: c.stock_tiers || [],
      }));
      await db.insert(colors).values(batch);
    }

    for (let i = 0; i < masterProductsData.length; i += BATCH_SIZE) {
      const batch = masterProductsData.slice(i, i + BATCH_SIZE).map((mp: any) => ({
        id: mp.id,
        code: mp.code,
        name: mp.name,
        basePrice: mp.base_price,
        uom: mp.uom,
        folderId: mp.folder_id,
        stockTier: mp.stock_tier,
        category: mp.category,
      }));
      await db.insert(masterProducts).values(batch);
    }

    console.log(`Configurator data seeded: ${foldersData.length} folders, ${colorsData.length} colors, ${masterProductsData.length} master products.`);
  } catch (error) {
    console.error("Error seeding configurator data:", error);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  await seedAgents();
  await seedConfiguratorData();

  // ==================== HEALTHCHECK ====================
  // Healthcheck endpoint per Cloud Run
  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      service: "hatfil-api"
    });
  });

  // ==================== AUTHENTICATION ====================
  app.post("/api/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username e password richiesti" });
      }
      
      const result = await arkeLogin(username, password);
      
      req.session.regenerate((err) => {
        if (err) {
          console.error("Session regeneration error:", err);
          return res.status(500).json({ error: "Errore interno" });
        }
        
        req.session.arkeToken = result.accessToken;
        req.session.user = {
          username: result.user.username,
          full_name: result.user.full_name,
          roles: result.user.roles,
        };
        
        req.session.save((saveErr) => {
          if (saveErr) {
            console.error("Session save error:", saveErr);
            return res.status(500).json({ error: "Errore interno" });
          }
          
          res.json({
            success: true,
            user: req.session.user,
          });
        });
      });
    } catch (error) {
      console.error("Login error:", error);
      const axiosError = error as { response?: { status?: number; data?: { message?: string } } };
      const status = axiosError.response?.status;
      
      if (status === 401 || status === 400) {
        return res.status(401).json({ error: "Credenziali non valide" });
      }
      
      res.status(401).json({ 
        error: "Login fallito. Verifica le tue credenziali."
      });
    }
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error("Logout error:", err);
        return res.status(500).json({ error: "Errore durante logout" });
      }
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  });

  app.get("/api/auth/status", (req, res) => {
    if (req.session?.arkeToken && req.session?.user) {
      res.json({
        authenticated: true,
        user: req.session.user,
      });
    } else {
      res.json({ authenticated: false });
    }
  });

  app.get("/api/arke/test", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const hasBaseUrl = !!process.env.ARKE_BASE_URL;
        const hasToken = !!process.env.ARKE_API_TOKEN;
        const tokenPreview = process.env.ARKE_API_TOKEN 
          ? `${process.env.ARKE_API_TOKEN.slice(0, 10)}...` 
          : "non impostato";
        
        console.log("Testing Arke connection...");
        console.log("ARKE_BASE_URL:", process.env.ARKE_BASE_URL || "non impostato");
        console.log("ARKE_API_TOKEN preview:", tokenPreview);
        
        const result = await arkeService.listSupplyOrders({ limit: 1 });
        
        res.json({
          config: {
            baseUrl: hasBaseUrl ? process.env.ARKE_BASE_URL : "non impostato",
            tokenSet: hasToken,
            tokenPreview: tokenPreview,
          },
          test: {
            success: result.success,
            error: result.error || null,
            dataReceived: result.success && !!result.data,
          },
        });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });
  });

  // ==================== AGENTS ====================
  app.get("/api/agents", async (req, res) => {
    try {
      const allAgents = await db.select().from(agents).where(eq(agents.isActive, 1));
      res.json(allAgents);
    } catch (error) {
      console.error("Error fetching agents:", error);
      res.status(500).json({ error: "Failed to fetch agents" });
    }
  });

  app.get("/api/agents/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [agent] = await db.select().from(agents).where(eq(agents.id, id));
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }
      res.json(agent);
    } catch (error) {
      console.error("Error fetching agent:", error);
      res.status(500).json({ error: "Failed to fetch agent" });
    }
  });

  // Start conversation with specific agent
  app.post("/api/agents/:id/start", async (req, res) => {
    try {
      const agentId = parseInt(req.params.id);
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }
      
      const conversation = await chatStorage.createConversationWithAgent(agent.name, agentId);
      
      if (agent.welcomeMessage) {
        await chatStorage.createMessage(conversation.id, "assistant", agent.welcomeMessage);
      }
      
      res.status(201).json({ 
        conversation, 
        agent,
        welcomeMessage: agent.welcomeMessage 
      });
    } catch (error) {
      console.error("Error starting agent conversation:", error);
      res.status(500).json({ error: "Failed to start conversation" });
    }
  });

  app.get("/api/conversations", async (req, res) => {
    try {
      const allConversations = await chatStorage.getAllConversations();
      res.json(allConversations);
    } catch (error) {
      console.error("Error fetching conversations:", error);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  app.get("/api/conversations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const conversation = await chatStorage.getConversation(id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      const messages = await chatStorage.getMessagesByConversation(id);
      res.json({ ...conversation, messages });
    } catch (error) {
      console.error("Error fetching conversation:", error);
      res.status(500).json({ error: "Failed to fetch conversation" });
    }
  });

  app.post("/api/conversations", async (req, res) => {
    try {
      const { title } = req.body;
      const conversation = await chatStorage.createConversation(title || "Nuova conversazione");
      res.status(201).json(conversation);
    } catch (error) {
      console.error("Error creating conversation:", error);
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  app.patch("/api/conversations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { title } = req.body;
      await chatStorage.updateConversationTitle(id, title);
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating conversation:", error);
      res.status(500).json({ error: "Failed to update conversation" });
    }
  });

  app.delete("/api/conversations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await chatStorage.deleteConversation(id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting conversation:", error);
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  app.post("/api/conversations/:id/messages", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const conversationId = parseInt(req.params.id);
        const { content } = req.body;

        await chatStorage.createMessage(conversationId, "user", content);

        // Get conversation to check for agent
        const conversation = await chatStorage.getConversation(conversationId);
      let systemPrompt = ARKE_SYSTEM_PROMPT;
      let agentTools = ARKE_TOOLS;
      let agentCategory = "Vendite"; // default to order agent
      
      // If conversation has an agent, use agent-specific prompt and tools
      if (conversation?.agentId) {
        const [agent] = await db.select().from(agents).where(eq(agents.id, conversation.agentId));
        if (agent) {
          systemPrompt = agent.systemPrompt;
          agentCategory = agent.category || "Vendite";
          
          // Select the correct tool set based on agent category
          if (agentCategory === "Analisi") {
            // Analisi Vendite agent uses its own tool set
            if (agent.tools && agent.tools.length > 0) {
              agentTools = ANALISI_VENDITE_TOOLS.filter(t => {
                const fn = (t as { type: string; function: { name: string } }).function;
                return fn && agent.tools.includes(fn.name);
              });
            } else {
              agentTools = ANALISI_VENDITE_TOOLS;
            }
          } else if (agentCategory === "Magazzino") {
            // Magazzino agent uses MAGAZZINO_TOOLS
            if (agent.tools && agent.tools.length > 0) {
              agentTools = MAGAZZINO_TOOLS.filter(t => {
                const fn = (t as { type: string; function: { name: string } }).function;
                return fn && agent.tools.includes(fn.name);
              });
            } else {
              agentTools = MAGAZZINO_TOOLS;
            }
          } else {
            // Order creation agent uses ARKE_TOOLS
            if (agent.tools && agent.tools.length > 0) {
              agentTools = ARKE_TOOLS.filter(t => {
                const fn = (t as { type: string; function: { name: string } }).function;
                return fn && agent.tools.includes(fn.name);
              });
            }
          }
        }
      }

      // Context injection: only for order creation agent (Vendite)
      let enhancedSystemPrompt = systemPrompt;
      if (agentCategory !== "Analisi" && agentCategory !== "Magazzino") {
        const stateBlock = await orderDraftService.getStateBlock(conversationId);
        const draft = await orderDraftService.getDraft(conversationId);
        const wizardContext = `WIZARD STEP CORRENTE: ${draft.wizardStep}`;
        enhancedSystemPrompt = `${systemPrompt}\n\n${stateBlock}\n${wizardContext}`;
      }

      // Get messages and limit to last 8 for token efficiency
      const allMessages = await chatStorage.getMessagesByConversation(conversationId);
      const recentMessages = allMessages.slice(-8);
      
      const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: enhancedSystemPrompt },
        ...recentMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Use more powerful model for Analisi and Magazzino agents (better reasoning)
      const modelToUse = (agentCategory === "Analisi" || agentCategory === "Magazzino") 
        ? "gpt-4o" 
        : "gpt-4o-mini";
      
      let response = await openai.chat.completions.create({
        model: modelToUse,
        messages: chatMessages,
        tools: agentTools.length > 0 ? agentTools : undefined,
        max_completion_tokens: 2048,
      });

      let assistantMessage = response.choices[0].message;
      let fullResponse = "";

      while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolResults: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        
        for (const toolCall of assistantMessage.tool_calls) {
          if (toolCall.type !== "function") continue;
          
          const operation: ArkeToolCall = {
            name: toolCall.function.name,
            arguments: JSON.parse(toolCall.function.arguments),
          };
          
          // LOGGING OBBLIGATORIO per ogni tool call
          console.log(`[TOOL CALL] ${operation.name} con Argomenti: ${JSON.stringify(operation.arguments)}`);
          
          res.write(`data: ${JSON.stringify({ type: "tool_call", tool: operation.name })}\n\n`);
          
          // Use correct handler based on agent category
          let result: string;
          if (agentCategory === "Analisi") {
            result = await executeAnalisiVenditeOperation(operation);
          } else if (agentCategory === "Magazzino") {
            result = await executeMagazzinoOperation(operation);
          } else {
            result = await executeArkeOperation(operation, conversationId);
          }
          
          console.log(`[TOOL RESULT] ${operation.name}: ${result.substring(0, 200)}${result.length > 200 ? '...' : ''}`);
          
          toolResults.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
        }

        chatMessages.push(assistantMessage as OpenAI.Chat.ChatCompletionMessageParam);
        chatMessages.push(...toolResults);

        response = await openai.chat.completions.create({
          model: modelToUse,
          messages: chatMessages,
          tools: agentTools.length > 0 ? agentTools : undefined,
          max_completion_tokens: 2048,
        });
        
        assistantMessage = response.choices[0].message;
      }

      fullResponse = assistantMessage.content || "";

      const chunks = fullResponse.match(/.{1,50}/g) || [fullResponse];
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ type: "content", content: chunk })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }

        await chatStorage.createMessage(conversationId, "assistant", fullResponse);

        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        res.end();
      } catch (error) {
        console.error("Error sending message:", error);
        if (res.headersSent) {
          res.write(`data: ${JSON.stringify({ type: "error", error: "Errore durante l'elaborazione del messaggio" })}\n\n`);
          res.end();
        } else {
          res.status(500).json({ error: "Failed to send message" });
        }
      }
    });
  });

  app.get("/api/arke/status", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const result = await arkeService.listWarehouses();
        res.json({ connected: result.success, error: result.error });
      } catch (error) {
        res.json({ connected: false, error: "Failed to connect to Arke" });
      }
    });
  });

  // ==================== PRODUCT CONFIGURATOR API ====================
  
  app.post("/api/configurator/import", async (req, res) => {
    try {
      const { importCatalogData } = await import("./scripts/import-catalog-data");
      const result = await importCatalogData();
      res.json({ success: true, ...result });
    } catch (error) {
      console.error("Import error:", error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Import failed" });
    }
  });
  
  app.get("/api/configurator/folders", async (req, res) => {
    try {
      const folders = await db.select().from(colorFolders);
      res.json(folders);
    } catch (error) {
      console.error("Error fetching folders:", error);
      res.status(500).json({ error: "Failed to fetch folders" });
    }
  });

  app.get("/api/configurator/color-folders/pdf", async (req, res) => {
    try {
      const PDFDocument = (await import("pdfkit")).default;
      const path = await import("path");
      const fs = await import("fs");

      const folders = await db.select().from(colorFolders);
      const allColors = await db.select({
        id: colors.id,
        code: colors.code,
        name: colors.name,
        folderId: colors.folderId,
        stockTiers: colors.stockTiers,
      }).from(colors);

      const colorsByFolder = new Map<number, typeof allColors>();
      for (const color of allColors) {
        if (!colorsByFolder.has(color.folderId)) {
          colorsByFolder.set(color.folderId, []);
        }
        colorsByFolder.get(color.folderId)!.push(color);
      }

      colorsByFolder.forEach((folderColors) => {
        folderColors.sort((a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code));
      });

      const doc = new PDFDocument({ 
        size: "A4", 
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
        info: {
          Title: "Cartella Colori - Hatfil",
          Author: "Hatfil S.r.l.",
          Subject: "Catalogo Colori Disponibili",
        }
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="cartella-colori-hatfil.pdf"');
      doc.pipe(res);

      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const primaryColor = "#292c32";
      const lightGray = "#f5f5f5";
      const mediumGray = "#e0e0e0";
      const textColor = "#333333";
      const mutedColor = "#777777";

      const logoPath = path.join(process.cwd(), "server", "assets", "hatfil-logo.png");
      const hasLogo = fs.existsSync(logoPath);

      const drawHeader = (isFirstPage = false) => {
        const headerY = doc.page.margins.top;

        if (hasLogo) {
          doc.image(logoPath, doc.page.margins.left, headerY, { height: 30 });
        }

        doc.fontSize(9).fillColor(mutedColor);
        doc.text("Hatfil S.r.l.", doc.page.margins.left + pageWidth - 200, headerY, { width: 200, align: "right" });
        doc.text("Via Gerani 17 - 25010 Acquafredda (BS)", doc.page.margins.left + pageWidth - 200, headerY + 11, { width: 200, align: "right" });
        doc.text("stefano.marchetti@hatfil.it", doc.page.margins.left + pageWidth - 200, headerY + 22, { width: 200, align: "right" });

        const lineY = headerY + 38;
        doc.moveTo(doc.page.margins.left, lineY)
          .lineTo(doc.page.margins.left + pageWidth, lineY)
          .strokeColor(primaryColor)
          .lineWidth(1.5)
          .stroke();

        if (isFirstPage) {
          doc.fontSize(20).fillColor(primaryColor).font("Helvetica-Bold");
          doc.text("Cartella Colori", doc.page.margins.left, lineY + 15, { align: "center", width: pageWidth });
          
          const today = new Date();
          const dateStr = today.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
          doc.fontSize(10).fillColor(mutedColor).font("Helvetica");
          doc.text(`Aggiornato al ${dateStr}`, doc.page.margins.left, lineY + 40, { align: "center", width: pageWidth });
          
          return lineY + 65;
        }
        
        return lineY + 15;
      };

      const drawFooter = () => {
        const footerY = doc.page.height - doc.page.margins.bottom - 15;
        doc.moveTo(doc.page.margins.left, footerY)
          .lineTo(doc.page.margins.left + pageWidth, footerY)
          .strokeColor(mediumGray)
          .lineWidth(0.5)
          .stroke();
        doc.fontSize(7).fillColor(mutedColor).font("Helvetica");
        doc.text("Hatfil S.r.l. - Documento riservato ad uso interno e commerciale", doc.page.margins.left, footerY + 4, { width: pageWidth, align: "center" });
      };

      let currentY = drawHeader(true);
      drawFooter();

      const sortedFolders = folders.sort((a, b) => a.code.localeCompare(b.code));

      for (let fi = 0; fi < sortedFolders.length; fi++) {
        const folder = sortedFolders[fi];
        const folderColors = colorsByFolder.get(folder.id) || [];
        if (folderColors.length === 0) continue;

        const colsPerRow = 4;
        const colWidth = pageWidth / colsPerRow;
        const rowHeight = 20;
        const headerHeight = 22;
        const folderTitleHeight = 35;
        const totalRows = Math.ceil(folderColors.length / colsPerRow);
        const tableHeight = headerHeight + totalRows * rowHeight;
        const neededSpace = folderTitleHeight + tableHeight + 20;

        if (currentY + neededSpace > doc.page.height - doc.page.margins.bottom - 30) {
          doc.addPage();
          currentY = drawHeader(false);
          drawFooter();
        }

        doc.fontSize(13).fillColor(primaryColor).font("Helvetica-Bold");
        doc.text(`${folder.name}`, doc.page.margins.left, currentY);
        doc.fontSize(9).fillColor(mutedColor).font("Helvetica");
        doc.text(`Codice: ${folder.code} | ${folderColors.length} colori disponibili`, doc.page.margins.left, currentY + 16);
        currentY += folderTitleHeight;

        for (let col = 0; col < colsPerRow; col++) {
          const x = doc.page.margins.left + col * colWidth;
          doc.rect(x, currentY, colWidth, headerHeight).fill(primaryColor);
          doc.fontSize(8).fillColor("#ffffff").font("Helvetica-Bold");
          doc.text("Codice", x + 8, currentY + 6, { width: colWidth - 16 });
        }
        currentY += headerHeight;

        for (let row = 0; row < totalRows; row++) {
          const rowY = currentY + row * rowHeight;

          if (rowY + rowHeight > doc.page.height - doc.page.margins.bottom - 30) {
            doc.addPage();
            currentY = drawHeader(false);
            drawFooter();

            for (let col = 0; col < colsPerRow; col++) {
              const x = doc.page.margins.left + col * colWidth;
              doc.rect(x, currentY, colWidth, headerHeight).fill(primaryColor);
              doc.fontSize(8).fillColor("#ffffff").font("Helvetica-Bold");
              doc.text("Codice", x + 8, currentY + 6, { width: colWidth - 16 });
            }
            currentY += headerHeight;
            
            const remainingRows = totalRows - row;
            for (let r = 0; r < remainingRows; r++) {
              const rY = currentY + r * rowHeight;
              if (rY + rowHeight > doc.page.height - doc.page.margins.bottom - 30) {
                break;
              }
              const bgColor = r % 2 === 0 ? "#ffffff" : lightGray;
              for (let col = 0; col < colsPerRow; col++) {
                const idx = (row + r) * colsPerRow + col;
                if (idx >= folderColors.length) break;
                const color = folderColors[idx];
                const x = doc.page.margins.left + col * colWidth;
                doc.rect(x, rY, colWidth, rowHeight).fill(bgColor);
                doc.rect(x, rY, colWidth, rowHeight).strokeColor(mediumGray).lineWidth(0.3).stroke();
                doc.fontSize(9).fillColor(textColor).font("Helvetica");
                const displayText = color.name ? `${color.code} - ${color.name}` : color.code;
                doc.text(displayText, x + 8, rY + 5, { width: colWidth - 16 });
              }
            }
            currentY += remainingRows * rowHeight;
            break;
          }

          const bgColor = row % 2 === 0 ? "#ffffff" : lightGray;
          for (let col = 0; col < colsPerRow; col++) {
            const idx = row * colsPerRow + col;
            if (idx >= folderColors.length) {
              const x = doc.page.margins.left + col * colWidth;
              doc.rect(x, rowY, colWidth, rowHeight).fill(bgColor);
              doc.rect(x, rowY, colWidth, rowHeight).strokeColor(mediumGray).lineWidth(0.3).stroke();
              continue;
            }
            const color = folderColors[idx];
            const x = doc.page.margins.left + col * colWidth;
            doc.rect(x, rowY, colWidth, rowHeight).fill(bgColor);
            doc.rect(x, rowY, colWidth, rowHeight).strokeColor(mediumGray).lineWidth(0.3).stroke();
            doc.fontSize(9).fillColor(textColor).font("Helvetica");
            const displayText = color.name ? `${color.code} - ${color.name}` : color.code;
            doc.text(displayText, x + 8, rowY + 5, { width: colWidth - 16 });
          }
        }
        currentY += totalRows * rowHeight + 20;
      }

      doc.end();
    } catch (error) {
      console.error("PDF generation error:", error);
      res.status(500).json({ error: "Failed to generate PDF" });
    }
  });

  app.get("/api/configurator/stock-catalog/pdf", async (req, res) => {
    try {
      const PDFDocument = (await import("pdfkit")).default;
      const path = await import("path");
      const fs = await import("fs");

      const allMasterProducts = await db.select().from(masterProducts);
      const folders = await db.select().from(colorFolders);
      const allColors = await db.select({
        id: colors.id,
        code: colors.code,
        name: colors.name,
        folderId: colors.folderId,
        stockTiers: colors.stockTiers,
      }).from(colors);

      const folderMap = new Map<number, typeof folders[0]>();
      for (const folder of folders) {
        folderMap.set(folder.id, folder);
      }

      const colorsByFolder = new Map<number, typeof allColors>();
      for (const color of allColors) {
        if (!colorsByFolder.has(color.folderId)) {
          colorsByFolder.set(color.folderId, []);
        }
        colorsByFolder.get(color.folderId)!.push(color);
      }

      const sortedProducts = allMasterProducts.sort((a, b) => a.code.localeCompare(b.code));

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
        info: {
          Title: "Catalogo Stock Filati - Hatfil",
          Author: "Hatfil S.r.l.",
          Subject: "Filati a Stock con Colori Disponibili",
        }
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="catalogo-stock-filati-hatfil.pdf"');
      doc.pipe(res);

      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const primaryColor = "#292c32";
      const lightGray = "#f5f5f5";
      const mediumGray = "#e0e0e0";
      const textColor = "#333333";
      const mutedColor = "#777777";
      const stockBlue = "#1e40af";

      const logoPath = path.join(process.cwd(), "server", "assets", "hatfil-logo.png");
      const hasLogo = fs.existsSync(logoPath);

      const drawHeader = (isFirstPage = false) => {
        const headerY = doc.page.margins.top;

        if (hasLogo) {
          doc.image(logoPath, doc.page.margins.left, headerY, { height: 30 });
        }

        doc.fontSize(9).fillColor(mutedColor);
        doc.text("Hatfil S.r.l.", doc.page.margins.left + pageWidth - 200, headerY, { width: 200, align: "right" });
        doc.text("Via Gerani 17 - 25010 Acquafredda (BS)", doc.page.margins.left + pageWidth - 200, headerY + 11, { width: 200, align: "right" });
        doc.text("stefano.marchetti@hatfil.it", doc.page.margins.left + pageWidth - 200, headerY + 22, { width: 200, align: "right" });

        const lineY = headerY + 38;
        doc.moveTo(doc.page.margins.left, lineY)
          .lineTo(doc.page.margins.left + pageWidth, lineY)
          .strokeColor(primaryColor)
          .lineWidth(1.5)
          .stroke();

        if (isFirstPage) {
          doc.fontSize(20).fillColor(primaryColor).font("Helvetica-Bold");
          doc.text("Catalogo Stock Filati", doc.page.margins.left, lineY + 15, { align: "center", width: pageWidth });

          const today = new Date();
          const dateStr = today.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
          doc.fontSize(10).fillColor(mutedColor).font("Helvetica");
          doc.text(`Aggiornato al ${dateStr}`, doc.page.margins.left, lineY + 40, { align: "center", width: pageWidth });

          return lineY + 65;
        }

        return lineY + 15;
      };

      const drawFooter = () => {
        const footerY = doc.page.height - doc.page.margins.bottom - 15;
        doc.moveTo(doc.page.margins.left, footerY)
          .lineTo(doc.page.margins.left + pageWidth, footerY)
          .strokeColor(mediumGray)
          .lineWidth(0.5)
          .stroke();
        doc.fontSize(7).fillColor(mutedColor).font("Helvetica");
        doc.text("Hatfil S.r.l. - Documento riservato ad uso interno e commerciale", doc.page.margins.left, footerY + 4, { width: pageWidth, align: "center" });
      };

      let currentY = drawHeader(true);
      drawFooter();

      const bottomLimit = doc.page.height - doc.page.margins.bottom - 30;

      for (const product of sortedProducts) {
        const folder = folderMap.get(product.folderId);
        if (!folder) continue;

        const folderColors = colorsByFolder.get(product.folderId) || [];
        const stockColors = folderColors.filter(c =>
          c.stockTiers && c.stockTiers.includes(product.stockTier)
        ).sort((a, b) => a.code.localeCompare(b.code));

        if (stockColors.length === 0) continue;

        const productHeaderHeight = 40;
        const colsPerRow = 8;
        const cellWidth = pageWidth / colsPerRow;
        const cellHeight = 22;
        const totalRows = Math.ceil(stockColors.length / colsPerRow);
        const gridHeight = totalRows * cellHeight;
        const neededSpace = productHeaderHeight + gridHeight + 25;

        if (currentY + neededSpace > bottomLimit) {
          doc.addPage();
          currentY = drawHeader(false);
          drawFooter();
        }

        doc.fontSize(12).fillColor(primaryColor).font("Helvetica-Bold");
        doc.text(product.code, doc.page.margins.left, currentY);

        const codeWidth = doc.widthOfString(product.code);
        doc.fontSize(9).fillColor(mutedColor).font("Helvetica");
        doc.text(product.name, doc.page.margins.left + codeWidth + 10, currentY + 2, { width: pageWidth - codeWidth - 10 });

        currentY += 17;

        doc.fontSize(9).fillColor(textColor).font("Helvetica");
        const priceText = `\u20AC ${product.basePrice}/${product.uom === "kilogram" ? "kg" : product.uom}`;
        doc.text(priceText, doc.page.margins.left, currentY);

        doc.fillColor(stockBlue);
        const tierText = product.stockTier.replace("STOCK_", "Stock ");
        const priceW = doc.widthOfString(priceText);
        doc.text(tierText, doc.page.margins.left + priceW + 15, currentY);

        doc.fillColor(mutedColor);
        const tierW = doc.widthOfString(tierText);
        doc.text(
          `Cartella: ${folder.name} | ${stockColors.length} colori a stock`,
          doc.page.margins.left + priceW + 15 + tierW + 15,
          currentY
        );

        currentY += 18;

        for (let row = 0; row < totalRows; row++) {
          const rowY = currentY + row * cellHeight;

          if (rowY + cellHeight > bottomLimit) {
            doc.addPage();
            currentY = drawHeader(false);
            drawFooter();

            doc.fontSize(10).fillColor(primaryColor).font("Helvetica-Bold");
            doc.text(`${product.code} (continua)`, doc.page.margins.left, currentY);
            currentY += 18;

            const remainingRows = totalRows - row;
            for (let r = 0; r < remainingRows; r++) {
              const rY = currentY + r * cellHeight;
              if (rY + cellHeight > bottomLimit) break;
              const bgColor = r % 2 === 0 ? "#ffffff" : lightGray;
              for (let col = 0; col < colsPerRow; col++) {
                const idx = (row + r) * colsPerRow + col;
                if (idx >= stockColors.length) {
                  const x = doc.page.margins.left + col * cellWidth;
                  doc.rect(x, rY, cellWidth, cellHeight).fill(bgColor);
                  doc.rect(x, rY, cellWidth, cellHeight).strokeColor(mediumGray).lineWidth(0.3).stroke();
                  continue;
                }
                const color = stockColors[idx];
                const x = doc.page.margins.left + col * cellWidth;
                doc.rect(x, rY, cellWidth, cellHeight).fill(bgColor);
                doc.rect(x, rY, cellWidth, cellHeight).strokeColor(mediumGray).lineWidth(0.3).stroke();
                doc.fontSize(9).fillColor(textColor).font("Helvetica-Bold");
                doc.text(color.code, x + 5, rY + 3, { width: cellWidth - 10, align: "center" });
                if (color.name) {
                  doc.fontSize(6).fillColor(mutedColor).font("Helvetica");
                  doc.text(color.name, x + 2, rY + 14, { width: cellWidth - 4, align: "center" });
                }
              }
            }
            currentY += (totalRows - row) * cellHeight;
            break;
          }

          const bgColor = row % 2 === 0 ? "#ffffff" : lightGray;
          for (let col = 0; col < colsPerRow; col++) {
            const idx = row * colsPerRow + col;
            if (idx >= stockColors.length) {
              const x = doc.page.margins.left + col * cellWidth;
              doc.rect(x, rowY, cellWidth, cellHeight).fill(bgColor);
              doc.rect(x, rowY, cellWidth, cellHeight).strokeColor(mediumGray).lineWidth(0.3).stroke();
              continue;
            }
            const color = stockColors[idx];
            const x = doc.page.margins.left + col * cellWidth;
            doc.rect(x, rowY, cellWidth, cellHeight).fill(bgColor);
            doc.rect(x, rowY, cellWidth, cellHeight).strokeColor(mediumGray).lineWidth(0.3).stroke();
            doc.fontSize(9).fillColor(textColor).font("Helvetica-Bold");
            doc.text(color.code, x + 5, rowY + 3, { width: cellWidth - 10, align: "center" });
            if (color.name) {
              doc.fontSize(6).fillColor(mutedColor).font("Helvetica");
              doc.text(color.name, x + 2, rowY + 14, { width: cellWidth - 4, align: "center" });
            }
          }
        }
        currentY += totalRows * cellHeight + 20;
      }

      doc.end();
    } catch (error) {
      console.error("Stock catalog PDF generation error:", error);
      res.status(500).json({ error: "Failed to generate stock catalog PDF" });
    }
  });

  app.get("/api/inventory/warehouse-stock/pdf", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    const mastersParam = req.query.masters as string | undefined;
    const selectedMasters = mastersParam ? mastersParam.split(",").map(m => m.trim()).filter(Boolean) : [];
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
    try {
      const PDFDocument = (await import("pdfkit")).default;
      const pathMod = await import("path");
      const fsMod = await import("fs");

      const warehousesResult = await arkeService.listWarehouses();
      if (!warehousesResult.success) {
        return res.status(500).json({ error: "Impossibile recuperare i magazzini da Arke" });
      }
      const warehouses = warehousesResult.data as Array<{ id: string; name: string; address?: { address: string; country: string; name: string } }>;
      const bresciaWarehouse = warehouses.find(w => w.name?.toLowerCase().includes("brescia"));
      if (!bresciaWarehouse) {
        return res.status(404).json({ error: "Magazzino Brescia non trovato" });
      }

      const allPdfInvItems = await arkeService.fetchAllInventoryItems();
      const invResult = { success: true, data: allPdfInvItems };
      if (!invResult.success) {
        return res.status(500).json({ error: "Impossibile recuperare le giacenze da Arke" });
      }
      const allInventory = invResult.data as Array<{
        product_id: string;
        internal_id: string;
        name: string;
        uom: string;
        warehouse_id?: string;
        warehouse_attr?: { id: string; name: string };
        lot?: string;
        external_lot?: string;
        buckets?: { available?: number; reserved?: number; in_production?: number; planned?: number; shipped?: number };
      }>;

      const bresciaInventory = allInventory.filter(inv =>
        inv.warehouse_id === bresciaWarehouse.id ||
        inv.warehouse_attr?.id === bresciaWarehouse.id ||
        inv.warehouse_attr?.name?.toLowerCase().includes("brescia")
      );

      const allMasterProds = await db.select().from(masterProducts);
      const masterProdByCode = new Map<string, typeof allMasterProds[0]>();
      for (const mp of allMasterProds) {
        masterProdByCode.set(mp.code, mp);
      }

      const masterCodesSorted = allMasterProds.map(mp => mp.code).sort((a, b) => b.length - a.length);

      interface InventoryLine {
        internalId: string;
        name: string;
        colorCode: string;
        uom: string;
        available: number;
        reserved: number;
        lot: string;
        externalLot: string;
      }

      const groupedByMaster = new Map<string, { master: typeof allMasterProds[0]; items: InventoryLine[] }>();

      for (const inv of bresciaInventory) {
        const available = inv.buckets?.available || 0;
        const reserved = inv.buckets?.reserved || 0;
        if (available === 0 && reserved === 0) continue;

        let matchedMasterCode = "";
        let colorCode = "";

        for (const mc of masterCodesSorted) {
          if (inv.internal_id.startsWith(mc + " - ")) {
            matchedMasterCode = mc;
            colorCode = inv.internal_id.substring(mc.length + 3).trim();
            break;
          }
        }

        if (!matchedMasterCode) {
          const dashIdx = inv.internal_id.lastIndexOf(" - ");
          if (dashIdx > 0) {
            matchedMasterCode = inv.internal_id.substring(0, dashIdx);
            colorCode = inv.internal_id.substring(dashIdx + 3).trim();
          } else {
            matchedMasterCode = inv.internal_id;
            colorCode = "";
          }
        }

        const master = masterProdByCode.get(matchedMasterCode);

        const key = matchedMasterCode;
        if (!groupedByMaster.has(key)) {
          groupedByMaster.set(key, {
            master: master || { id: 0, code: matchedMasterCode, name: inv.name.split(" - ")[0] || matchedMasterCode, basePrice: "0", uom: inv.uom, folderId: 0, stockTier: "", category: "" },
            items: [],
          });
        }

        groupedByMaster.get(key)!.items.push({
          internalId: inv.internal_id,
          name: inv.name,
          colorCode,
          uom: inv.uom,
          available,
          reserved,
          lot: inv.lot || "",
          externalLot: inv.external_lot || "",
        });
      }

      const allGroups = Array.from(groupedByMaster.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      const sortedGroups = selectedMasters.length > 0
        ? allGroups.filter(([code]) => selectedMasters.includes(code))
        : allGroups;

      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margins: { top: 40, bottom: 40, left: 40, right: 40 },
        info: {
          Title: "Giacenze Magazzino Brescia - Hatfil",
          Author: "Hatfil S.r.l.",
          Subject: "Inventario filati magazzino Brescia",
        }
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="giacenze-brescia-hatfil.pdf"');
      doc.pipe(res);

      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const primaryColor = "#292c32";
      const lightGray = "#f5f5f5";
      const mediumGray = "#e0e0e0";
      const textColor = "#333333";
      const mutedColor = "#777777";
      const greenColor = "#16a34a";
      const amberColor = "#d97706";

      const logoPath = pathMod.join(process.cwd(), "server", "assets", "hatfil-logo.png");
      const hasLogo = fsMod.existsSync(logoPath);

      const drawHeader = (isFirstPage = false) => {
        const headerY = doc.page.margins.top;

        if (hasLogo) {
          doc.image(logoPath, doc.page.margins.left, headerY, { height: 30 });
        }

        doc.fontSize(9).fillColor(mutedColor);
        doc.text("Hatfil S.r.l.", doc.page.margins.left + pageWidth - 200, headerY, { width: 200, align: "right" });
        doc.text("Via Gerani 17 - 25010 Acquafredda (BS)", doc.page.margins.left + pageWidth - 200, headerY + 11, { width: 200, align: "right" });
        doc.text("stefano.marchetti@hatfil.it", doc.page.margins.left + pageWidth - 200, headerY + 22, { width: 200, align: "right" });

        const lineY = headerY + 38;
        doc.moveTo(doc.page.margins.left, lineY)
          .lineTo(doc.page.margins.left + pageWidth, lineY)
          .strokeColor(primaryColor)
          .lineWidth(1.5)
          .stroke();

        if (isFirstPage) {
          doc.fontSize(18).fillColor(primaryColor).font("Helvetica-Bold");
          const pdfTitle = selectedMasters.length > 0
            ? `Giacenze Magazzino Brescia - ${selectedMasters.join(", ")}`
            : "Giacenze Magazzino Brescia";
          doc.text(pdfTitle, doc.page.margins.left, lineY + 12, { align: "center", width: pageWidth });

          const today = new Date();
          const dateStr = today.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
          doc.fontSize(10).fillColor(mutedColor).font("Helvetica");
          doc.text(`Aggiornato al ${dateStr} | ${bresciaInventory.filter(i => (i.buckets?.available || 0) > 0 || (i.buckets?.reserved || 0) > 0).length} articoli in stock`, doc.page.margins.left, lineY + 35, { align: "center", width: pageWidth });

          return lineY + 58;
        }

        return lineY + 15;
      };

      const drawFooter = () => {
        const footerY = doc.page.height - doc.page.margins.bottom - 15;
        doc.moveTo(doc.page.margins.left, footerY)
          .lineTo(doc.page.margins.left + pageWidth, footerY)
          .strokeColor(mediumGray)
          .lineWidth(0.5)
          .stroke();
        doc.fontSize(7).fillColor(mutedColor).font("Helvetica");
        doc.text("Hatfil S.r.l. - Documento riservato ad uso interno e commerciale", doc.page.margins.left, footerY + 4, { width: pageWidth, align: "center" });
      };

      let currentY = drawHeader(true);
      drawFooter();

      const bottomLimit = doc.page.height - doc.page.margins.bottom - 30;

      const colWidths = {
        color: pageWidth * 0.10,
        name: pageWidth * 0.45,
        extLot: pageWidth * 0.18,
        available: pageWidth * 0.15,
        uom: pageWidth * 0.12,
      };
      const rowHeight = 20;

      const drawTableHeader = (y: number) => {
        doc.rect(doc.page.margins.left, y, pageWidth, rowHeight).fill(primaryColor);

        doc.fontSize(8).fillColor("#ffffff").font("Helvetica-Bold");
        let x = doc.page.margins.left + 5;
        doc.text("Colore", x, y + 4, { width: colWidths.color - 10 });
        x += colWidths.color;
        doc.text("Descrizione", x, y + 4, { width: colWidths.name - 10 });
        x += colWidths.name;
        doc.text("Lotto Fornitore", x, y + 4, { width: colWidths.extLot - 10 });
        x += colWidths.extLot;
        doc.text("Disponibile", x, y + 4, { width: colWidths.available - 10, align: "right" });
        x += colWidths.available;
        doc.text("UdM", x, y + 4, { width: colWidths.uom - 10, align: "center" });

        return y + rowHeight;
      };

      const drawItemRows = (items: InventoryLine[], masterCode: string, startRowIndex: number, sectionLabel: string) => {
        for (let i = 0; i < items.length; i++) {
          if (currentY + rowHeight > bottomLimit) {
            doc.addPage();
            currentY = drawHeader(false);
            drawFooter();

            doc.fontSize(9).fillColor(primaryColor).font("Helvetica-Bold");
            doc.text(`${masterCode} - ${sectionLabel} (continua)`, doc.page.margins.left, currentY);
            currentY += 16;
            currentY = drawTableHeader(currentY);
          }

          const item = items[i];
          const bgColor = (startRowIndex + i) % 2 === 0 ? "#ffffff" : lightGray;
          doc.rect(doc.page.margins.left, currentY, pageWidth, rowHeight).fill(bgColor);

          doc.fontSize(8).font("Helvetica");
          let x = doc.page.margins.left + 5;

          doc.fillColor(primaryColor).font("Helvetica-Bold");
          doc.text(item.colorCode || "-", x, currentY + 4, { width: colWidths.color - 10 });
          x += colWidths.color;

          doc.fillColor(textColor).font("Helvetica");
          let displayName = item.name;
          const masterPrefix = masterCode + " - " + item.colorCode + " - ";
          if (displayName.startsWith(masterPrefix)) {
            displayName = displayName.substring(masterPrefix.length);
          } else {
            const altPrefix = masterCode + " - " + item.colorCode + " ";
            if (displayName.startsWith(altPrefix)) {
              displayName = displayName.substring(altPrefix.length);
            }
          }
          doc.text(displayName, x, currentY + 4, { width: colWidths.name - 10 });
          x += colWidths.name;

          doc.fillColor(mutedColor);
          doc.text(item.externalLot || "-", x, currentY + 4, { width: colWidths.extLot - 10 });
          x += colWidths.extLot;

          doc.fillColor(greenColor).font("Helvetica-Bold");
          doc.text(item.available.toFixed(2), x, currentY + 4, { width: colWidths.available - 10, align: "right" });
          x += colWidths.available;

          const itemUom = item.uom === "kilogram" ? "kg" : item.uom;
          doc.fillColor(mutedColor).font("Helvetica");
          doc.text(itemUom, x, currentY + 4, { width: colWidths.uom - 10, align: "center" });

          currentY += rowHeight;
        }
      };

      for (const [masterCode, group] of sortedGroups) {
        const master = group.master;
        const allItems = group.items.sort((a, b) => a.colorCode.localeCompare(b.colorCode));

        const kgItems = allItems.filter(i => i.uom === "kilogram" || i.uom === "kg");
        if (kgItems.length === 0) continue;

        const kgTotal = kgItems.reduce((sum, i) => sum + i.available, 0);

        const productHeaderH = 28;
        const tableHeaderH = rowHeight;
        const minRows = Math.min(kgItems.length, 3);
        const neededSpace = productHeaderH + tableHeaderH + minRows * rowHeight + 15;

        if (currentY + neededSpace > bottomLimit) {
          doc.addPage();
          currentY = drawHeader(false);
          drawFooter();
        }

        doc.fontSize(11).fillColor(primaryColor).font("Helvetica-Bold");
        doc.text(masterCode, doc.page.margins.left, currentY);

        const codeW = doc.widthOfString(masterCode);
        doc.fontSize(8).fillColor(mutedColor).font("Helvetica");
        doc.text(master.name, doc.page.margins.left + codeW + 10, currentY + 2, { width: pageWidth * 0.35 });

        doc.fontSize(9).fillColor(greenColor).font("Helvetica-Bold");
        doc.text(`${kgTotal.toFixed(2)} kg disp.`, doc.page.margins.left + pageWidth - 250, currentY + 1, { width: 250, align: "right" });

        doc.fontSize(8).fillColor(mutedColor).font("Helvetica");
        doc.text(`${kgItems.length} varianti`, doc.page.margins.left, currentY + 14);

        currentY += productHeaderH;

        currentY = drawTableHeader(currentY);
        drawItemRows(kgItems, masterCode, 0, "Colori");

        doc.moveTo(doc.page.margins.left, currentY)
          .lineTo(doc.page.margins.left + pageWidth, currentY)
          .strokeColor(mediumGray)
          .lineWidth(0.3)
          .stroke();

        currentY += 15;
      }

      if (sortedGroups.length === 0) {
        doc.fontSize(14).fillColor(mutedColor).font("Helvetica");
        doc.text("Nessuna giacenza trovata nel magazzino di Brescia", doc.page.margins.left, currentY + 30, { align: "center", width: pageWidth });
      }

      doc.end();
    } catch (error) {
      console.error("Warehouse stock PDF generation error:", error);
      res.status(500).json({ error: "Failed to generate warehouse stock PDF" });
    }
    });
  });
  
  app.get("/api/configurator/folders/:id/colors", async (req, res) => {
    try {
      const folderId = parseInt(req.params.id);
      const folderColors = await db.select().from(colors).where(eq(colors.folderId, folderId));
      res.json(folderColors);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch colors" });
    }
  });
  
  app.get("/api/configurator/master-products", async (req, res) => {
    try {
      const products = await db.select({
        id: masterProducts.id,
        code: masterProducts.code,
        name: masterProducts.name,
        basePrice: masterProducts.basePrice,
        uom: masterProducts.uom,
        stockTier: masterProducts.stockTier,
        category: masterProducts.category,
        folderId: masterProducts.folderId,
        folderCode: colorFolders.code,
        folderName: colorFolders.name,
      })
      .from(masterProducts)
      .leftJoin(colorFolders, eq(masterProducts.folderId, colorFolders.id));
      
      res.json(products);
    } catch (error) {
      console.error("Error fetching master products:", error);
      res.status(500).json({ error: "Failed to fetch master products" });
    }
  });
  
  app.get("/api/configurator/master-products/:id", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const productId = parseInt(req.params.id);
        
        const [product] = await db.select({
          id: masterProducts.id,
          code: masterProducts.code,
          name: masterProducts.name,
          basePrice: masterProducts.basePrice,
          uom: masterProducts.uom,
          stockTier: masterProducts.stockTier,
          category: masterProducts.category,
          folderId: masterProducts.folderId,
          folderCode: colorFolders.code,
          folderName: colorFolders.name,
        })
        .from(masterProducts)
        .leftJoin(colorFolders, eq(masterProducts.folderId, colorFolders.id))
        .where(eq(masterProducts.id, productId));
        
        if (!product) {
          return res.status(404).json({ error: "Product not found" });
        }
        
        const folderColors = await db.select().from(colors).where(eq(colors.folderId, product.folderId));
        
        const stockColors = folderColors.filter(c => 
          c.stockTiers?.includes(product.stockTier)
        );
        
        const generated = await db.select().from(generatedProducts)
          .where(eq(generatedProducts.masterProductId, productId));
        
        const generatedColorIds = new Set(generated.map(g => g.colorId));
        const generatedArkeMap = new Map(generated.map(g => [g.colorId, g.arkeProductId]));

        const arkeGeneratedColorCodes = new Set<string>();
        const arkeProductIdByColorCode = new Map<string, string>();
        try {
          let allArkeProducts: Array<{ internal_id: string; id: string }> = [];
          let offset = 0;
          const limit = 100;
          let hasMore = true;
          while (hasMore) {
            const arkeResult = await arkeService.listProducts({ search: product.code, limit, offset });
            const products = (arkeResult.data as Array<{ internal_id: string; id: string }>) || [];
            allArkeProducts = allArkeProducts.concat(products);
            hasMore = products.length === limit;
            offset += limit;
          }
          const prefix = `${product.code} - `;
          for (const ap of allArkeProducts) {
            if (ap.internal_id && ap.internal_id.startsWith(prefix)) {
              const colorCode = ap.internal_id.substring(prefix.length).trim();
              if (colorCode) {
                arkeGeneratedColorCodes.add(colorCode);
                arkeProductIdByColorCode.set(colorCode, ap.id);
              }
            }
          }
        } catch (arkeError) {
          console.warn("Could not fetch Arke products for duplicate check, using local data only:", arkeError);
        }

        let generatedCount = 0;
        const colorsWithStatus = folderColors.map(c => {
          const isLocalGenerated = generatedColorIds.has(c.id);
          const isArkeGenerated = arkeGeneratedColorCodes.has(c.code);
          const isGenerated = isLocalGenerated || isArkeGenerated;
          if (isGenerated) generatedCount++;
          const arkeProductId = generatedArkeMap.get(c.id) || arkeProductIdByColorCode.get(c.code) || undefined;
          return {
            ...c,
            isStock: c.stockTiers?.includes(product.stockTier) || false,
            isGenerated,
            arkeProductId,
          };
        });
        
        res.json({
          ...product,
          colors: colorsWithStatus,
          stockCount: stockColors.length,
          totalColors: folderColors.length,
          generatedCount,
        });
      } catch (error) {
        console.error("Error fetching master product:", error);
        res.status(500).json({ error: "Failed to fetch master product" });
      }
    });
  });

  app.post("/api/configurator/master-products", async (req, res) => {
    try {
      const { code, name, basePrice, uom, folderId, stockTier, category } = req.body;
      
      if (!code || !name || !basePrice || !folderId || !stockTier) {
        return res.status(400).json({ error: "Campi obbligatori mancanti: code, name, basePrice, folderId, stockTier" });
      }
      
      const [existing] = await db.select().from(masterProducts).where(eq(masterProducts.code, code));
      if (existing) {
        return res.status(409).json({ error: `Prodotto con codice "${code}" esiste già` });
      }
      
      const [newProduct] = await db.insert(masterProducts).values({
        code,
        name,
        basePrice: basePrice.toString(),
        uom: uom || "kilogram",
        folderId: parseInt(folderId),
        stockTier,
        category: category || "evolution",
      }).returning();
      
      res.status(201).json(newProduct);
    } catch (error) {
      console.error("Error creating master product:", error);
      res.status(500).json({ error: "Failed to create master product" });
    }
  });

  app.put("/api/configurator/master-products/:id", async (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const { code, name, basePrice, uom, folderId, stockTier, category } = req.body;
      
      const [existing] = await db.select().from(masterProducts).where(eq(masterProducts.id, productId));
      if (!existing) {
        return res.status(404).json({ error: "Prodotto master non trovato" });
      }
      
      if (code && code !== existing.code) {
        const [codeExists] = await db.select().from(masterProducts).where(eq(masterProducts.code, code));
        if (codeExists) {
          return res.status(409).json({ error: `Prodotto con codice "${code}" esiste già` });
        }
      }
      
      const updateData: Record<string, any> = {};
      if (code !== undefined) updateData.code = code;
      if (name !== undefined) updateData.name = name;
      if (basePrice !== undefined) updateData.basePrice = basePrice.toString();
      if (uom !== undefined) updateData.uom = uom;
      if (folderId !== undefined) updateData.folderId = parseInt(folderId);
      if (stockTier !== undefined) updateData.stockTier = stockTier;
      if (category !== undefined) updateData.category = category;
      
      const [updated] = await db.update(masterProducts)
        .set(updateData)
        .where(eq(masterProducts.id, productId))
        .returning();
      
      const markResult = await db.update(generatedProducts)
        .set({ syncStatus: "needs_update", updatedAt: new Date() })
        .where(eq(generatedProducts.masterProductId, productId));
      
      res.json({ 
        ...updated, 
        variantsMarkedForSync: markResult.rowCount ?? 0 
      });
    } catch (error) {
      console.error("Error updating master product:", error);
      res.status(500).json({ error: "Failed to update master product" });
    }
  });

  app.post("/api/configurator/sync-variants", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { masterProductId } = req.body;
        
        if (!masterProductId) {
          return res.status(400).json({ error: "masterProductId richiesto" });
        }
        
        const [masterProduct] = await db.select().from(masterProducts).where(eq(masterProducts.id, parseInt(masterProductId)));
        if (!masterProduct) {
          return res.status(404).json({ error: "Prodotto master non trovato" });
        }
        
        const allGenerated = await db.select().from(generatedProducts)
          .where(eq(generatedProducts.masterProductId, parseInt(masterProductId)));
        
        const needsUpdate = allGenerated.filter(g => 
          g.syncStatus === "needs_update" || g.syncStatus === "failed"
        );
        
        if (needsUpdate.length === 0) {
          return res.json({ success: true, results: [], totalSynced: 0, totalFailed: 0, message: "Nessuna variante da aggiornare" });
        }
        
        const results: { generatedId: number; arkeInternalId: string; success: boolean; error?: string }[] = [];
        const price = parseFloat(masterProduct.basePrice);
        
        for (const generated of needsUpdate) {
          try {
            if (!generated.arkeProductId) {
              results.push({ generatedId: generated.id, arkeInternalId: generated.arkeInternalId, success: false, error: "Nessun arkeProductId" });
              continue;
            }
            
            const arkeResult = await arkeService.getProduct(generated.arkeProductId);
            if (!arkeResult.success || !arkeResult.data) {
              results.push({ generatedId: generated.id, arkeInternalId: generated.arkeInternalId, success: false, error: "Prodotto non trovato in Arke" });
              await db.update(generatedProducts).set({ syncStatus: "failed", updatedAt: new Date() }).where(eq(generatedProducts.id, generated.id));
              continue;
            }
            
            const arkeProduct = arkeResult.data as any;
            
            const updateResult = await arkeService.updateProduct(generated.arkeProductId, {
              name: arkeProduct.name,
              internal_id: arkeProduct.internal_id,
              type: arkeProduct.type,
              uom: masterProduct.uom,
              categories: arkeProduct.categories || [],
              description: arkeProduct.description || "",
              version: arkeProduct.version,
              attributes: arkeProduct.attributes || {},
              prices: {
                currency: "EUR",
                unit: price,
                vat: 0,
                deals: [{ min_quantity: 1, unit: price, category: "Prezzo unità" }],
              },
              plan: arkeProduct.plan || [],
              raw_materials: arkeProduct.raw_materials || [],
            });
            
            if (updateResult.success) {
              await db.update(generatedProducts)
                .set({ syncStatus: "synced", updatedAt: new Date() })
                .where(eq(generatedProducts.id, generated.id));
              results.push({ generatedId: generated.id, arkeInternalId: generated.arkeInternalId, success: true });
            } else {
              await db.update(generatedProducts)
                .set({ syncStatus: "failed", updatedAt: new Date() })
                .where(eq(generatedProducts.id, generated.id));
              results.push({ generatedId: generated.id, arkeInternalId: generated.arkeInternalId, success: false, error: updateResult.error });
            }
          } catch (err) {
            await db.update(generatedProducts)
              .set({ syncStatus: "failed", updatedAt: new Date() })
              .where(eq(generatedProducts.id, generated.id));
            results.push({ 
              generatedId: generated.id, 
              arkeInternalId: generated.arkeInternalId, 
              success: false, 
              error: err instanceof Error ? err.message : "Errore sconosciuto" 
            });
          }
        }
        
        res.json({
          success: results.every(r => r.success),
          results,
          totalSynced: results.filter(r => r.success).length,
          totalFailed: results.filter(r => !r.success).length,
        });
      } catch (error) {
        console.error("Error syncing variants:", error);
        res.status(500).json({ error: "Failed to sync variants" });
      }
    });
  });
  
  app.post("/api/configurator/check-duplicates", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { masterProductId, colorIds } = req.body as { masterProductId: number; colorIds: number[] };
        
        const [product] = await db.select().from(masterProducts).where(eq(masterProducts.id, masterProductId));
        if (!product) {
          return res.status(404).json({ error: "Master product not found" });
        }
        
        const selectedColors = await db.select().from(colors).where(inArray(colors.id, colorIds));
        
        const duplicates: { colorId: number; colorCode: string; arkeInternalId: string; exists: boolean }[] = [];
        const available: { colorId: number; colorCode: string; arkeInternalId: string }[] = [];
        
        for (const color of selectedColors) {
          const arkeInternalId = `${product.code} - ${color.code}`;
          
          const [existingLocal] = await db.select().from(generatedProducts)
            .where(eq(generatedProducts.arkeInternalId, arkeInternalId));
          
          if (existingLocal) {
            duplicates.push({ colorId: color.id, colorCode: color.code, arkeInternalId, exists: true });
          } else {
            const arkeResult = await arkeService.listProducts({ search: arkeInternalId, limit: 5 });
            const arkeProducts = arkeResult.data as Array<{ internal_id: string }> | undefined;
            const existsInArke = arkeProducts?.some(p => p.internal_id === arkeInternalId);
            
            if (existsInArke) {
              duplicates.push({ colorId: color.id, colorCode: color.code, arkeInternalId, exists: true });
            } else {
              available.push({ colorId: color.id, colorCode: color.code, arkeInternalId });
            }
          }
        }
        
        res.json({ duplicates, available, masterProduct: product });
      } catch (error) {
        console.error("Error checking duplicates:", error);
        res.status(500).json({ error: "Failed to check duplicates" });
      }
    });
  });
  
  app.post("/api/configurator/generate-products", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { masterProductId, colorIds } = req.body as { masterProductId: number; colorIds: number[] };
        
        const [product] = await db.select().from(masterProducts).where(eq(masterProducts.id, masterProductId));
        if (!product) {
          return res.status(404).json({ error: "Master product not found" });
        }
        
        const selectedColors = await db.select().from(colors).where(inArray(colors.id, colorIds));
        
        const results: { colorCode: string; arkeInternalId: string; success: boolean; arkeProductId?: string; error?: string; supplierAssociated?: boolean; supplierError?: string }[] = [];
      
      // Turkey supplier ID (Hatfil Tekstil Isletmeleri A.S.)
      const TURKEY_SUPPLIER_ID = "67b2e189-b9ee-42af-8aa9-ddd8bf6e2e62";
      
      for (const color of selectedColors) {
        const arkeInternalId = `${product.code} - ${color.code}`;
        const arkeName = `${product.code} - ${color.code} - ${product.name}`;
        const price = parseFloat(product.basePrice);
        
        try {
          // Step 1: Create the purchasable product
          const createResult = await arkeService.createProduct({
            name: arkeName,
            type: "purchasable",
            uom: product.uom,
            internal_id: arkeInternalId,
            master_type: product.code,
            categories: [color.code],
            prices: {
              currency: "EUR",
              unit: price,
              vat: 0,
              deals: [{ min_quantity: 1, unit: price, category: "Prezzo unità" }],
            },
            custom_form_values: {
              generation: 0,
              values: [
                { index: 0, label: "Variante", name: "variante", type: "string", value: color.code }
              ],
            },
          });
          
          if (createResult.success && createResult.data) {
            const arkeProduct = createResult.data as { id: string };
            
            // Step 2: Associate the Turkey supplier with the product
            const supplierResult = await arkeService.createProductSupplier(arkeProduct.id, {
              supplier_id: TURKEY_SUPPLIER_ID,
              external_id: arkeInternalId,
              minimum_quantity: 1,
              uom: product.uom,
              prices: {
                currency: "EUR",
                unit: parseFloat(product.basePrice),
                vat: 0,
              },
            });
            
            const supplierAssociated = supplierResult.success;
            
            await db.insert(generatedProducts).values({
              masterProductId: product.id,
              colorId: color.id,
              arkeProductId: arkeProduct.id,
              arkeInternalId,
              syncStatus: supplierAssociated ? "synced" : "partial",
            });
            
            results.push({ 
              colorCode: color.code, 
              arkeInternalId, 
              success: true, 
              arkeProductId: arkeProduct.id,
              supplierAssociated,
              supplierError: supplierAssociated ? undefined : supplierResult.error,
            });
          } else {
            results.push({ colorCode: color.code, arkeInternalId, success: false, error: createResult.error });
          }
        } catch (err) {
          results.push({ colorCode: color.code, arkeInternalId, success: false, error: err instanceof Error ? err.message : "Unknown error" });
        }
      }
      
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      
        res.json({ 
          success: true, 
          results,
          summary: { total: results.length, success: successCount, failed: failCount }
        });
      } catch (error) {
        console.error("Error generating products:", error);
        res.status(500).json({ error: "Failed to generate products" });
      }
    });
  });
  
  app.get("/api/configurator/generated-products", async (req, res) => {
    try {
      const generated = await db.select({
        id: generatedProducts.id,
        arkeProductId: generatedProducts.arkeProductId,
        arkeInternalId: generatedProducts.arkeInternalId,
        syncStatus: generatedProducts.syncStatus,
        createdAt: generatedProducts.createdAt,
        masterProductCode: masterProducts.code,
        colorCode: colors.code,
        colorName: colors.name,
      })
      .from(generatedProducts)
      .leftJoin(masterProducts, eq(generatedProducts.masterProductId, masterProducts.id))
      .leftJoin(colors, eq(generatedProducts.colorId, colors.id));
      
      res.json(generated);
    } catch (error) {
      console.error("Error fetching generated products:", error);
      res.status(500).json({ error: "Failed to fetch generated products" });
    }
  });

  // Customer search API for configurator
  app.get("/api/arke/customers", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { search, limit } = req.query;
        const result = await arkeService.listCustomers({
          search: search as string,
          limit: limit ? parseInt(limit as string) : 10,
        });
        res.json(result);
      } catch (error) {
        console.error("Error searching customers:", error);
        res.status(500).json({ error: "Failed to search customers" });
      }
    });
  });

  // ==================== ERP PROXY ROUTES ====================

  app.get("/api/sales/orders", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { limit, offset, status, search } = req.query;
        const result = await arkeService.listSalesOrders({
          limit: limit ? parseInt(limit as string) : 50,
          offset: offset ? parseInt(offset as string) : undefined,
          status: status as string,
          search: search as string,
        });
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch sales orders" });
      }
    });
  });

  app.get("/api/sales/orders/:id", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const result = await arkeService.getSalesOrder(req.params.id);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch order details" });
      }
    });
  });

  app.get("/api/products", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { limit, offset, search, category } = req.query;
        const result = await arkeService.listProducts({
          limit: limit ? parseInt(limit as string) : 50,
          offset: offset ? parseInt(offset as string) : undefined,
          search: search as string,
          category: category as string,
        });
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch products" });
      }
    });
  });

  app.get("/api/products/:id", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const result = await arkeService.getProduct(req.params.id);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch product details" });
      }
    });
  });

  app.get("/api/inventory", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const allItems = await arkeService.fetchAllInventoryItems();
        res.json({ success: true, data: allItems });
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch inventory" });
      }
    });
  });

  app.get("/api/inventory/value", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const [allValueInvItems, prodResult] = await Promise.all([
          arkeService.fetchAllInventoryItems(),
          arkeService.listProducts({ limit: 2000 }),
        ]);

        if (!prodResult.success) {
          return res.status(500).json({ error: "Impossibile recuperare i prodotti" });
        }

        const inventory = allValueInvItems as Array<{
          product_id: string;
          internal_id: string;
          name: string;
          uom: string;
          warehouse_id?: string;
          warehouse_attr?: { id: string; name: string };
          buckets?: { available?: number; reserved?: number };
        }>;

        const products = prodResult.data as Array<{
          id: string;
          internal_id?: string;
          name: string;
          uom: string;
          prices?: { unit?: number; currency?: string };
        }>;

        const priceMap = new Map<string, number>();
        const productUomMap = new Map<string, string>();
        for (const p of products) {
          if (p.id) {
            if (p.prices?.unit) {
              priceMap.set(p.id, p.prices.unit);
            }
            productUomMap.set(p.id, (p.uom || "").toLowerCase());
          }
        }

        const allMasterProds = await db.select().from(masterProducts);
        const masterProdByCode = new Map<string, typeof allMasterProds[0]>();
        for (const mp of allMasterProds) {
          masterProdByCode.set(mp.code, mp);
        }
        const masterCodesSorted = allMasterProds.map(mp => mp.code).sort((a, b) => b.length - a.length);

        interface FamilyValue {
          masterCode: string;
          masterName: string;
          variantCount: number;
          totalQty: number;
          totalValue: number;
          uom: string;
          avgPrice: number;
          pricedCount: number;
        }

        const familyMap = new Map<string, FamilyValue>();

        for (const inv of inventory) {
          const available = inv.buckets?.available || 0;
          if (available <= 0) continue;

          const invUom = (inv.uom || "").toLowerCase();
          const prodUom = productUomMap.get(inv.product_id) || invUom;
          if (invUom === "unit" || invUom === "units" || invUom === "piece" || invUom === "pieces" ||
              prodUom === "unit" || prodUom === "units" || prodUom === "piece" || prodUom === "pieces") continue;

          const idUpper = (inv.internal_id || "").toUpperCase();
          const nameUpper = (inv.name || "").toUpperCase();
          if (idUpper.includes("PANEL") || idUpper.includes("PART CONE") ||
              nameUpper.includes("PANEL") || nameUpper.includes("PART CONE")) continue;

          let matchedMasterCode = "";
          for (const mc of masterCodesSorted) {
            if (inv.internal_id.startsWith(mc + " - ")) {
              matchedMasterCode = mc;
              break;
            }
          }
          if (!matchedMasterCode) {
            const dashIdx = inv.internal_id.lastIndexOf(" - ");
            if (dashIdx > 0) {
              matchedMasterCode = inv.internal_id.substring(0, dashIdx);
            } else {
              matchedMasterCode = inv.internal_id;
            }
          }

          const unitPrice = priceMap.get(inv.product_id) || 0;
          const lineValue = available * unitPrice;

          const master = masterProdByCode.get(matchedMasterCode);
          const existing = familyMap.get(matchedMasterCode);

          if (existing) {
            existing.variantCount++;
            existing.totalQty += available;
            existing.totalValue += lineValue;
            if (unitPrice > 0) existing.pricedCount++;
          } else {
            familyMap.set(matchedMasterCode, {
              masterCode: matchedMasterCode,
              masterName: master?.name || matchedMasterCode,
              variantCount: 1,
              totalQty: available,
              totalValue: lineValue,
              uom: (prodUom === "kilogram" || invUom === "kilogram") ? "kg" : (prodUom || invUom),
              avgPrice: 0,
              pricedCount: unitPrice > 0 ? 1 : 0,
            });
          }
        }

        const families: FamilyValue[] = [];
        let grandTotal = 0;
        let grandQty = 0;

        familyMap.forEach((fam) => {
          fam.avgPrice = fam.pricedCount > 0 ? fam.totalValue / fam.totalQty : 0;
          grandTotal += fam.totalValue;
          grandQty += fam.totalQty;
          families.push(fam);
        });

        families.sort((a, b) => b.totalValue - a.totalValue);

        res.json({
          success: true,
          grandTotal,
          grandQty,
          familyCount: families.length,
          families,
        });
      } catch (error) {
        console.error("Inventory value error:", error);
        res.status(500).json({ error: "Failed to compute inventory value" });
      }
    });
  });

  app.get("/api/customers", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { search, limit, offset } = req.query;
        const result = await arkeService.listCustomers({
          search: search as string,
          limit: limit ? parseInt(limit as string) : 50,
          offset: offset ? parseInt(offset as string) : undefined,
        });
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch customers" });
      }
    });
  });

  app.get("/api/customers/:id", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const result = await arkeService.getCustomer(req.params.id);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch customer details" });
      }
    });
  });

  app.get("/api/suppliers", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { limit, offset } = req.query;
        const result = await arkeService.listSuppliers({
          limit: limit ? parseInt(limit as string) : 50,
          offset: offset ? parseInt(offset as string) : undefined,
        });
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch suppliers" });
      }
    });
  });

  app.get("/api/suppliers/:id", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const result = await arkeService.getSupplier(req.params.id);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch supplier details" });
      }
    });
  });

  // Custom Colors API
  app.get("/api/configurator/custom-colors", async (req, res) => {
    try {
      const allCustomColors = await db.select().from(customColors).orderBy(customColors.createdAt);
      res.json(allCustomColors);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch custom colors" });
    }
  });

  app.post("/api/configurator/custom-colors", async (req, res) => {
    try {
      const { code, name, customerId, customerName } = req.body as { 
        code: string; 
        name?: string; 
        customerId: string; 
        customerName: string; 
      };
      
      const [newColor] = await db.insert(customColors).values({
        code,
        name: name || null,
        customerId,
        customerName,
      }).returning();
      
      res.json(newColor);
    } catch (error) {
      console.error("Error creating custom color:", error);
      res.status(500).json({ error: "Failed to create custom color" });
    }
  });

  // Generate products with custom color
  app.post("/api/configurator/generate-custom-product", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { masterProductId, colorCode, customerId, customerName } = req.body as { 
          masterProductId: number; 
          colorCode: string; 
          customerId: string; 
          customerName: string; 
        };
        
        const [product] = await db.select().from(masterProducts).where(eq(masterProducts.id, masterProductId));
        if (!product) {
          return res.status(404).json({ error: "Master product not found" });
        }
        
        const arkeInternalId = `${product.code} - ${colorCode}`;
        const arkeName = `${product.code} - ${colorCode} - ${product.name}`;
        const price = parseFloat(product.basePrice);
        
        // Turkey supplier ID (Hatfil Tekstil Isletmeleri A.S.)
        const TURKEY_SUPPLIER_ID = "67b2e189-b9ee-42af-8aa9-ddd8bf6e2e62";
        
        // Check if already exists
        const arkeResult = await arkeService.listProducts({ search: arkeInternalId, limit: 5 });
      const arkeProducts = arkeResult.data as Array<{ internal_id: string }> | undefined;
      const existsInArke = arkeProducts?.some(p => p.internal_id === arkeInternalId);
      
      if (existsInArke) {
        return res.status(400).json({ error: `Il prodotto ${arkeInternalId} esiste già su Arke` });
      }
      
      // Create the purchasable product with custom color
      const createResult = await arkeService.createProduct({
        name: arkeName,
        type: "purchasable",
        uom: product.uom,
        internal_id: arkeInternalId,
        master_type: product.code,
        categories: [colorCode, "custom"],
        description: `Colore custom per cliente: ${customerName}`,
        prices: {
          currency: "EUR",
          unit: price,
          vat: 0,
          deals: [{ min_quantity: 1, unit: price, category: "Prezzo unità" }],
        },
        custom_form_values: {
          generation: 0,
          values: [
            { index: 0, label: "Variante", name: "variante", type: "string", value: colorCode }
          ],
        },
      });
      
      if (createResult.success && createResult.data) {
        const arkeProduct = createResult.data as { id: string };
        
        // Associate the Turkey supplier
        const supplierResult = await arkeService.createProductSupplier(arkeProduct.id, {
          supplier_id: TURKEY_SUPPLIER_ID,
          external_id: arkeInternalId,
          minimum_quantity: 1,
          uom: product.uom,
          prices: {
            currency: "EUR",
            unit: price,
            vat: 0,
          },
        });
        
        // Save custom color for future reference
        await db.insert(customColors).values({
          code: colorCode,
          name: null,
          customerId,
          customerName,
        }).onConflictDoNothing();
        
        res.json({
          success: true,
          arkeInternalId,
          arkeProductId: arkeProduct.id,
          supplierAssociated: supplierResult.success,
          customerName,
        });
        } else {
          res.status(400).json({ 
            success: false, 
            error: createResult.error || "Failed to create product" 
          });
        }
      } catch (error) {
        console.error("Error generating custom product:", error);
        res.status(500).json({ error: "Failed to generate custom product" });
      }
    });
  });

  // Debug endpoint to analyze existing purchasable product structure
  app.get("/api/configurator/debug/product/:productId", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { productId } = req.params;
        
        // Get product details
        const productResult = await arkeService.getProduct(productId);
        
        // Get product suppliers
        const suppliersResult = await arkeService.getProductSuppliers(productId);
        
        res.json({
          product: productResult,
          suppliers: suppliersResult,
        });
      } catch (error) {
        console.error("Debug endpoint error:", error);
        res.status(500).json({ error: "Failed to fetch product details" });
      }
    });
  });

  // ==================== DDT INBOUND API ====================

  // Get warehouses for DDT inbound
  app.get("/api/warehouses", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const result = await arkeService.listWarehouses();
        if (result.success && result.data) {
          res.json(result.data);
        } else {
          res.status(500).json({ error: result.error || "Failed to fetch warehouses" });
        }
      } catch (error) {
        console.error("Error fetching warehouses:", error);
        res.status(500).json({ error: "Failed to fetch warehouses" });
      }
    });
  });

  // Extract data from PDF using AI
  app.post("/api/ddt-inbound/extract", upload.single("pdf"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No PDF file uploaded" });
      }

      // Parse PDF to extract text
      const fs = await import("fs");
      const path = await import("path");
      const { execSync } = await import("child_process");
      
      // Write buffer to temp file
      const tempPath = `/tmp/pdf_${Date.now()}.pdf`;
      fs.writeFileSync(tempPath, req.file.buffer);
      
      // Use pdftotext (poppler) to extract text
      let pdfText: string;
      try {
        pdfText = execSync(`pdftotext -layout "${tempPath}" -`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      } finally {
        // Clean up temp file
        try { fs.unlinkSync(tempPath); } catch {}
      }

      // Log extracted PDF text for debugging
      console.log("[DDT Extract] PDF text length:", pdfText.length);
      console.log("[DDT Extract] PDF text preview (first 2000 chars):", pdfText.substring(0, 2000));

      // Use AI to extract structured data from PDF text
      const extractionPrompt = `Analizza questo testo estratto da una fattura commerciale HATFIL e restituisci un JSON strutturato.

⚠️ REGOLA CRITICA: DEVI ESTRARRE TUTTI I PRODOTTI SENZA ECCEZIONI!
Non troncare, non saltare righe. Se ci sono 32 prodotti, devi restituire 32 oggetti nel JSON.

TESTO FATTURA:
${pdfText}

ISTRUZIONI:
1. Estrai numero fattura (Invoice No) e data fattura (Invoice Date)
2. Per OGNI SINGOLA riga prodotto nella tabella, estrai:
   - SPECIFICATION: nome completo del prodotto
   - LOT NUMBER: codice lotto
   - Net Weight: peso netto in kg
   - Price Per kg: prezzo unitario
3. Calcola il valore totale

TIPI DI PRODOTTI DA CERCARE (tutti presenti nella fattura):
- PARSLEY 14 GLOSS (con codici colore 6xxx)
- PARSLEY 14 (senza GLOSS, con codici colore 0xxx o 1xxx)
- PARSLEY 12 (con codici colore 0xxx)
- PARSLEY 7 (con codici colore 0xxx)
- SUZETTE 12 (con codici colore 0xxx)
- NE 30/1 COMPACT (con codici 00xxx o Kxxx)

REGOLA ESTRAZIONE CAMPI:
Per ogni prodotto devi estrarre:
- originalName: il nome del prodotto SENZA note di spedizione. RIMUOVI sempre parti come "(FOR WALTER...)", "(FOR M+M STUDIO...)", "(FOR SELDOM...)", numeri tra parentesi come "(1)", "(2)" che indicano destinazioni. Esempio: "NE 20/2 %100 COTION GOTS GASSED SPLASH (2) ( FOR WALTER STÖHR COMPANY)" diventa "NE 20/2 %100 COTION GOTS GASSED SPLASH"
- masterType: SOLO il tipo principale senza variante (es. "NE 30/1 COMPACT", "PARSLEY 14 GLOSS", "PARSLEY 14", "PARSLEY 12", "PARSLEY 7", "SUZETTE 12")
- variant: il codice variante/colore (es. "K165", "6015", "0010", "00802", "0050", "0160")
- internalId: masterType + " - " + variant (es. "NE 30/1 COMPACT - K165", "PARSLEY 14 - 0050")

ESEMPI:
- "PARSLEY 14 GLOSS NM 2/50 GOTS 6015" → masterType: "PARSLEY 14 GLOSS", variant: "6015"
- "PARSLEY 14 NM2/50 GOTS 1440" → masterType: "PARSLEY 14", variant: "1440"
- "PARSLEY 14 NM2/50 GOTS 0050" → masterType: "PARSLEY 14", variant: "0050"
- "PARSLEY 12 NM3/50 GOTS 0050" → masterType: "PARSLEY 12", variant: "0050"
- "PARSLEY 7 NM/850 GOTS 0160" → masterType: "PARSLEY 7", variant: "0160"
- "SUZETTE 12 NM3/50 GOTS 0010" → masterType: "SUZETTE 12", variant: "0010"
- "NE 30/1 COMPACT 00802 BLU" → masterType: "NE 30/1 COMPACT", variant: "00802"
- "NE 30/ 1 COMPACT Kl65 GIRIGIOTTO" → masterType: "NE 30/1 COMPACT", variant: "K165"

Rispondi SOLO con JSON valido, senza markdown:
{
  "invoiceNumber": "string",
  "invoiceDate": "string",
  "products": [
    {
      "originalName": "nome COMPLETO originale dalla fattura",
      "masterType": "tipo principale senza variante",
      "variant": "codice variante/colore",
      "internalId": "masterType - variant",
      "lotNumber": "codice lotto",
      "netWeight": number,
      "price": number,
      "uom": "KG"
    }
  ],
  "totalValue": number
}`;

      const aiResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: extractionPrompt }],
        temperature: 0.1,
        max_tokens: 8000,
      });

      const responseText = aiResponse.choices[0]?.message?.content || "{}";
      console.log("[DDT Extract] AI response length:", responseText.length);
      let extractedData;
      try {
        extractedData = JSON.parse(responseText.replace(/```json\n?|\n?```/g, "").trim());
        console.log("[DDT Extract] Products extracted:", extractedData.products?.length || 0);
      } catch {
        console.error("Failed to parse AI response:", responseText);
        return res.status(500).json({ error: "Failed to parse extraction result" });
      }

      // Get token from session for Arke API calls
      const sessionToken = req.session?.arkeToken ?? null;
      
      // Match each extracted product by searching individually in Arke
      // Wrap in requestContext to ensure token is available for arkeService calls
      const matchedProducts = await requestContext.run({ arkeToken: sessionToken }, () => 
        Promise.all(
          extractedData.products.map(async (product: {
          originalName: string;
          masterType: string;
          variant: string;
          internalId: string;
          lotNumber: string;
          netWeight: number;
          price: number;
          uom: string;
        }, index: number) => {
          // Helper to normalize product codes for comparison (removes extra spaces, normalizes dashes)
          const normalizeCode = (code: string): string => {
            return code
              .toLowerCase()
              .replace(/\s+/g, ' ')      // Collapse multiple spaces
              .replace(/\s*-\s*/g, '-')  // Normalize spaces around dashes
              .trim();
          };
          
          // Search for the product by internalId in Arke
          const searchResult = await arkeService.listProducts({ 
            search: product.internalId, 
            limit: 50  // Increase limit to find more potential matches
          });
          
          const arkeProducts = (searchResult.data as Array<{
            id: string;
            internal_id: string;
            name: string;
            type: string;
            uom: string;
          }>) || [];
          
          console.log(`[DDT Inbound] Searching for: "${product.internalId}" (normalized: "${normalizeCode(product.internalId)}")`);
          console.log(`[DDT Inbound] Found ${arkeProducts.length} products, types: ${arkeProducts.map(p => p.type).join(', ')}`);
          
          // Filter purchasable OR saleable products (products that can be received)
          const validProducts = arkeProducts.filter(p => 
            p.type === "purchasable" || p.type === "saleable"
          );
          
          console.log(`[DDT Inbound] Valid products after type filter: ${validProducts.length}`);
          
          const normalizedSearchCode = normalizeCode(product.internalId);
          
          // Try exact match first with normalized codes
          let matchedProduct = validProducts.find(
            p => normalizeCode(p.internal_id || '') === normalizedSearchCode
          );
          
          // If no exact match, try partial match on internal_id
          if (!matchedProduct) {
            matchedProduct = validProducts.find(
              p => {
                const normalizedArkeCode = normalizeCode(p.internal_id || '');
                return normalizedArkeCode.includes(normalizedSearchCode) ||
                       normalizedSearchCode.includes(normalizedArkeCode);
              }
            );
          }
          
          console.log(`[DDT Inbound] Match result for "${product.internalId}": ${matchedProduct ? `FOUND (${matchedProduct.internal_id})` : 'NOT FOUND'}`);

          let rawMaterialInfo = null;
          if (matchedProduct) {
            // Get supplier info to get raw_material fittizio
            const supplierResult = await arkeService.getProductSuppliers(matchedProduct.id);
            if (supplierResult.success && supplierResult.data) {
              const suppliers = supplierResult.data as Array<{
                id: string;
                external_id: string;
                supplier_id: string;
              }>;
              // Find HATFIL supplier association
              const hatfilSupplier = suppliers.find(s => s.supplier_id === HATFIL_SUPPLIER_ID);
              if (hatfilSupplier) {
                rawMaterialInfo = {
                  id: hatfilSupplier.id,
                  external_id: hatfilSupplier.external_id,
                };
              }
            }
          }

          return {
            id: `product-${index}-${Date.now()}`,
            originalName: product.originalName,
            masterType: product.masterType,
            variant: product.variant,
            internalId: product.internalId,
            arkeFullName: matchedProduct?.name || product.originalName,
            lotNumber: product.lotNumber,
            netWeight: product.netWeight,
            price: product.price,
            uom: matchedProduct?.uom || "kilogram",
            matched: !!matchedProduct,
            productId: matchedProduct?.id,
            rawMaterialId: rawMaterialInfo?.id,
            rawMaterialExternalId: rawMaterialInfo?.external_id,
            isNew: !matchedProduct,
          };
        })
      ));

      res.json({
        invoiceNumber: extractedData.invoiceNumber,
        invoiceDate: extractedData.invoiceDate,
        supplierName: HATFIL_SUPPLIER_NAME,
        supplierId: HATFIL_SUPPLIER_ID,
        products: matchedProducts,
        totalValue: extractedData.totalValue || 0,
      });
    } catch (error) {
      console.error("Error extracting from PDF:", error);
      res.status(500).json({ error: "Failed to extract data from PDF" });
    }
  });

  // Confirm DDT inbound - create products if needed and create transport document
  app.post("/api/ddt-inbound/confirm", async (req, res) => {
    // Get token from session for Arke API calls
    const sessionToken = req.session?.arkeToken ?? null;
    
    // Wrap entire handler in requestContext to ensure token is available
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { 
          invoiceNumber, 
          invoiceDate, 
          products, 
          warehouseId,
          warehouseName,
          supplierId = HATFIL_SUPPLIER_ID,
        } = req.body as {
        invoiceNumber: string;
        invoiceDate: string;
        products: Array<{
          id: string;
          originalName: string;
          masterType: string;
          variant: string;
          internalId: string;
          arkeFullName?: string;
          lotNumber: string;
          netWeight: number;
          price: number;
          uom: string;
          matched: boolean;
          productId?: string;
          rawMaterialId?: string;
          rawMaterialExternalId?: string;
          isNew: boolean;
        }>;
        warehouseId: string;
        warehouseName?: string;
        supplierId?: string;
      };

      if (!warehouseId) {
        return res.status(400).json({ error: "Warehouse ID is required" });
      }

      console.log("[DDT Confirm] warehouseId:", warehouseId, "warehouseName:", warehouseName);

      // Use warehouse name from frontend (API endpoint for single warehouse doesn't work)
      const warehouse = warehouseName ? { id: warehouseId, name: warehouseName } : undefined;
      console.log("[DDT Confirm] warehouse data:", warehouse);

      // Process each product - create new ones if needed
      const rawMaterials: Array<{
        id?: string;
        extra_id: string;
        name: string;
        quantity: number;
        uom: string;
        external_lot: string;
        prices: { currency: "EUR"; unit: number; vat: number };
      }> = [];

      for (const product of products) {
        let rawMaterialId = product.rawMaterialId;
        let rawMaterialExternalId = product.rawMaterialExternalId || product.internalId;

        if (product.isNew) {
          console.log(`[DDT Confirm] Creating NEW product: ${product.internalId}`);
          // Create new purchasable product with correct structure
          const createProductResult = await arkeService.createProduct({
            name: product.originalName,
            type: "purchasable",
            uom: product.uom,
            internal_id: product.internalId,
            master_type: product.masterType,
            categories: [],
            description: `Prodotto importato da fattura ${invoiceNumber}`,
            prices: {
              currency: "EUR",
              unit: 0,
              vat: 0,
              deals: [
                {
                  min_quantity: 1,
                  unit: product.price,
                  category: "Unit price",
                },
              ],
            },
            custom_form_values: {
              generation: 0,
              values: [
                {
                  name: "variante",
                  label: "VARIANTE",
                  type: "FormFieldV1",
                  index: 0,
                  value: product.variant,
                },
              ],
            },
          });

          if (!createProductResult.success || !createProductResult.data) {
            console.error(`[DDT Confirm] Failed to create product ${product.internalId}:`, createProductResult.error);
            continue;
          }

          const newProduct = createProductResult.data as { id: string };
          console.log(`[DDT Confirm] Product created successfully: ${product.internalId} -> ${newProduct.id}`);

          // Associate with HATFIL supplier (this creates the raw_material fittizio)
          const supplierResult = await arkeService.createProductSupplier(newProduct.id, {
            supplier_id: supplierId,
            external_id: product.internalId,
            minimum_quantity: 1,
            uom: product.uom,
            prices: {
              currency: "EUR",
              unit: product.price,
              vat: 0,
            },
          });

          if (supplierResult.success && supplierResult.data) {
            const supplierData = supplierResult.data as { id: string; external_id: string };
            rawMaterialId = supplierData.id;
            rawMaterialExternalId = supplierData.external_id;
          }
        }

        rawMaterials.push({
          id: rawMaterialId,
          extra_id: rawMaterialExternalId,
          name: product.arkeFullName || product.originalName,
          quantity: product.netWeight,
          uom: product.uom || "kilogram",
          external_lot: product.lotNumber,
          prices: {
            currency: "EUR",
            unit: product.price,
            vat: 0,
          },
        });
      }

      // Create the inbound transport document
      const ddtPayload = {
        external_id: invoiceNumber,
        status: "inbound" as const,
        warehouse_id: warehouseId,
        warehouse_attr: warehouse ? { id: warehouse.id, name: warehouse.name } : undefined,
        supplier_id: supplierId,
        supplier_attr: {
          id: supplierId,
          name: HATFIL_SUPPLIER_NAME,
          vat: HATFIL_SUPPLIER_VAT,
          country: "TR",
        },
        time: new Date().toISOString(),
        raw_materials: rawMaterials,
      };
      console.log("[DDT Confirm] payload:", JSON.stringify(ddtPayload, null, 2));
      const ddtResult = await arkeService.createInboundTransportDocument(ddtPayload);

      if (!ddtResult.success) {
        return res.status(500).json({ error: ddtResult.error || "Failed to create DDT" });
      }

      res.json({
        success: true,
        ...(ddtResult.data as Record<string, unknown>),
      });
    } catch (error) {
      console.error("Error confirming DDT:", error);
      res.status(500).json({ error: "Failed to confirm DDT" });
    }
    });
  });

  // ==================== TURKEY FULFILLMENT (Quick order fulfillment) ====================
  
  // Get active sales orders that can be fulfilled
  app.get("/api/turkey-fulfillment/orders", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const result = await arkeService.listActiveOrders({ limit: 100 });
        if (!result.success) {
          return res.status(500).json({ error: result.error || "Failed to fetch active orders" });
        }
        
        // Filter only accepted orders (ready to be fulfilled)
        const orders = (result.data as Array<{
          id: string;
          internal_id?: string;
          name: string;
          status: string;
          expected_delivery_time?: string;
          total_vat_incl?: number;
          customer_attr?: { name?: string };
          products?: Array<{ name: string; quantity: number; uom: string }>;
        }>) || [];
        
        const acceptedOrders = orders.filter(o => o.status === "accepted" || o.status === "sent");
        
        res.json(acceptedOrders);
      } catch (error) {
        console.error("Error fetching active orders:", error);
        res.status(500).json({ error: "Failed to fetch active orders" });
      }
    });
  });

  // Get order details
  app.get("/api/turkey-fulfillment/order/:id", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { id } = req.params;
        const result = await arkeService.getSalesOrder(id);
        
        if (!result.success) {
          return res.status(500).json({ error: result.error || "Failed to fetch order" });
        }
        
        res.json(result.data);
      } catch (error) {
        console.error("Error fetching order:", error);
        res.status(500).json({ error: "Failed to fetch order" });
      }
    });
  });

  // Check inventory availability for products in a specific warehouse
  app.post("/api/turkey-fulfillment/check-inventory", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const { warehouseId, products } = req.body as {
          warehouseId: string;
          products: Array<{ productId: string; extra_id: string; requiredQuantity: number }>;
        };

        if (!warehouseId || !products?.length) {
          return res.status(400).json({ error: "Missing warehouseId or products" });
        }

        const inventoryStatus: Array<{
          productId: string;
          extra_id: string;
          availableQuantity: number;
          requiredQuantity: number;
          difference: number;
          needsAdjustment: boolean;
        }> = [];

        for (const product of products) {
          try {
            const invResult = await arkeService.listProductInventory(product.productId);
            let availableQuantity = 0;

            if (invResult.success && invResult.data) {
              const inventoryItems = invResult.data as Array<{
                warehouse_id?: string;
                buckets?: { available?: number };
              }>;
              
              // Sum available quantity in the specified warehouse
              const warehouseItems = inventoryItems.filter(item => item.warehouse_id === warehouseId);
              availableQuantity = warehouseItems.reduce((sum, item) => sum + (item.buckets?.available || 0), 0);
            }

            const difference = product.requiredQuantity - availableQuantity;
            inventoryStatus.push({
              productId: product.productId,
              extra_id: product.extra_id,
              availableQuantity,
              requiredQuantity: product.requiredQuantity,
              difference: difference > 0 ? difference : 0,
              needsAdjustment: difference > 0,
            });
          } catch (err) {
            console.error(`Error checking inventory for ${product.productId}:`, err);
            inventoryStatus.push({
              productId: product.productId,
              extra_id: product.extra_id,
              availableQuantity: 0,
              requiredQuantity: product.requiredQuantity,
              difference: product.requiredQuantity,
              needsAdjustment: true,
            });
          }
        }

        res.json({ inventoryStatus });
      } catch (error) {
        console.error("Error checking inventory:", error);
        res.status(500).json({ error: "Failed to check inventory" });
      }
    });
  });

  // Fulfill order: load inventory + create DDT
  app.post("/api/turkey-fulfillment/fulfill", async (req, res) => {
    const sessionToken = req.session?.arkeToken ?? null;
    
    return requestContext.run({ arkeToken: sessionToken }, async () => {
      try {
        const {
          orderId,
          orderInternalId,
          warehouseId,
          warehouseName,
          warehouseType,
          shippingAddress,
          products,
          inventoryAdjustments,
        } = req.body as {
          orderId: string;
          orderInternalId: string;
          warehouseId: string;
          warehouseName: string;
          warehouseType: string;
          shippingAddress: string;
          products: Array<{
            id: string;
            productId: string;
            extra_id: string;
            name: string;
            quantity: number;
            uom: string;
          }>;
          inventoryAdjustments?: Array<{
            productId: string;
            adjustmentQuantity: number;
          }>;
        };

        if (!orderId || !warehouseId || !products?.length) {
          return res.status(400).json({ error: "Missing required fields: orderId, warehouseId, products" });
        }

      // Determine if this is a "virtual" warehouse (Turkey) or physical warehouse (Brescia)
      const isVirtualWarehouse = warehouseType === "virtual";
      const warehouseLabel = isVirtualWarehouse ? "Turchia" : warehouseName;

      console.log(`[Fulfillment] Starting fulfillment for order: ${orderId}, warehouse type: ${warehouseType}`);
      
      const inventoryResults: Array<{ productId: string; success: boolean; error?: string; action?: string }> = [];
      const ddtProducts: Array<{
        id?: string;
        extra_id: string;
        name: string;
        quantity: number;
        uom: string;
        order_id?: string;
        lot?: string;
        item_id?: string;
      }> = [];

      // Step 1: Handle inventory based on warehouse type
      for (const product of products) {
        let adjustSuccess = true;
        let adjustError: string | undefined;
        let action = "";

        if (isVirtualWarehouse) {
          // TURKEY: Load inventory (+quantity)
          console.log(`[Fulfillment] TURKEY: Loading inventory for ${product.extra_id}: +${product.quantity} ${product.uom}`);
          action = "carico";
          
          const adjustResult = await arkeService.adjustInventory(product.productId, {
            bucket: "available",
            quantity: product.quantity,
            reason: `Caricamento per evasione ordine ${orderInternalId} (${warehouseLabel})`,
            warehouse_id: warehouseId,
            warehouse_attr: { id: warehouseId, name: warehouseName },
          });
          
          adjustSuccess = adjustResult.success;
          adjustError = adjustResult.error;
        } else {
          // BRESCIA: Check if adjustment is needed, then unload (-quantity)
          const adjustment = inventoryAdjustments?.find(a => a.productId === product.productId);
          
          // If there's a shortage, first load the difference
          if (adjustment && adjustment.adjustmentQuantity > 0) {
            console.log(`[Fulfillment] BRESCIA: Adjusting inventory for ${product.extra_id}: +${adjustment.adjustmentQuantity} ${product.uom} (rettifica)`);
            action = "rettifica+scarico";
            
            const rectifyResult = await arkeService.adjustInventory(product.productId, {
              bucket: "available",
              quantity: adjustment.adjustmentQuantity,
              reason: `Rettifica giacenza per evasione ordine ${orderInternalId}`,
              warehouse_id: warehouseId,
              warehouse_attr: { id: warehouseId, name: warehouseName },
            });
            
            if (!rectifyResult.success) {
              adjustSuccess = false;
              adjustError = rectifyResult.error || "Failed to rectify inventory";
            }
          } else {
            action = "scarico";
          }
          
          // Now unload the quantity
          if (adjustSuccess) {
            console.log(`[Fulfillment] BRESCIA: Unloading inventory for ${product.extra_id}: -${product.quantity} ${product.uom}`);
            
            const unloadResult = await arkeService.adjustInventory(product.productId, {
              bucket: "available",
              quantity: -product.quantity,
              reason: `Scarico per evasione ordine ${orderInternalId}`,
              warehouse_id: warehouseId,
              warehouse_attr: { id: warehouseId, name: warehouseName },
            });
            
            adjustSuccess = unloadResult.success;
            adjustError = unloadResult.error;
          }
        }

        inventoryResults.push({
          productId: product.productId,
          success: adjustSuccess,
          error: adjustError,
          action,
        });

        // Always add products to DDT regardless of inventory adjustment result
        // (API may return error but still execute the operation)
        let lotNumber: string | undefined;
        let itemId: string | undefined;
        
        try {
          const invResult = await arkeService.listProductInventory(product.productId);
          if (invResult.success && invResult.data) {
            const inventoryItems = invResult.data as Array<{
              id?: string;
              lot?: string;
              warehouse_id?: string;
              buckets?: { available?: number };
            }>;
            
            // Find the inventory item for this warehouse
            const warehouseItem = inventoryItems.find(
              item => item.warehouse_id === warehouseId
            );
            
            if (warehouseItem) {
              lotNumber = warehouseItem.lot;
              itemId = warehouseItem.id;
              console.log(`[Turkey Fulfillment] Found inventory item for ${product.extra_id}: lot=${lotNumber}, item_id=${itemId}`);
            } else {
              console.log(`[Turkey Fulfillment] No inventory item found for ${product.extra_id} in warehouse ${warehouseId}`);
            }
          }
        } catch (err) {
          console.error(`[Turkey Fulfillment] Error fetching inventory for ${product.productId}:`, err);
        }

        ddtProducts.push({
          id: product.id,
          extra_id: product.extra_id,
          name: product.name,
          quantity: product.quantity,
          uom: product.uom,
          order_id: orderId,
          lot: lotNumber,
          item_id: itemId,
        });
      }

      // Check if all inventory adjustments succeeded
      const failedAdjustments = inventoryResults.filter(r => !r.success);
      if (failedAdjustments.length > 0) {
        console.error("[Turkey Fulfillment] Some inventory adjustments failed:", failedAdjustments);
      }

      // Step 2: Create the sales transport document (DDT)
      console.log("[Turkey Fulfillment] Creating sales DDT...");
      
      const ddtResult = await arkeService.createSalesTransportDocument({
        order_id: orderId,
        order_internal_id: orderInternalId,
        status: "draft",
        warehouse_id: warehouseId,
        warehouse_attr: { id: warehouseId, name: warehouseName },
        shipping_address: shippingAddress,
        reason: "Evasione ordine da Turchia",
        products: ddtProducts,
      });

      if (!ddtResult.success) {
        return res.status(500).json({ 
          error: ddtResult.error || "Failed to create DDT",
          inventoryResults,
        });
      }

      console.log("[Turkey Fulfillment] DDT created successfully:", ddtResult.data);

        res.json({
          success: true,
          ddt: ddtResult.data,
          inventoryResults,
          message: `Ordine ${orderInternalId} evaso con successo. DDT creato.`,
        });
      } catch (error) {
        console.error("Error fulfilling order:", error);
        res.status(500).json({ error: "Failed to fulfill order" });
      }
    });
  });

  return httpServer;
}
