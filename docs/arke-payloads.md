# Arke API - Payload Reference

Questa documentazione definisce le strutture esatte dei payload per ogni operazione Arke. Le funzioni in `server/arke.ts` DEVONO costruire questi payload in modo deterministico, senza dipendere dall'AI per la correttezza dei dati.

## Principio Architetturale

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│   Utente (Chat)     │────▶│   AI (Interpreta)   │────▶│ Function Calling    │
│   "Voglio un        │     │   Capisce intent:   │     │ create_sales_order  │
│    ordine per       │     │   - cliente         │     │ (Deterministico)    │
│    MADEWELL"        │     │   - prodotti        │     │                     │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
                                                                   │
                                                                   ▼
                                                        ┌─────────────────────┐
                                                        │   arkeService       │
                                                        │   Costruisce        │
                                                        │   payload COMPLETO  │
                                                        │   + validazione     │
                                                        └─────────────────────┘
```

**REGOLA FONDAMENTALE**: L'AI passa solo gli identificatori essenziali (customer_id, product codes, quantities). La funzione `arkeService` costruisce il payload completo recuperando i dati mancanti se necessario.

---

## Sales Orders (Ordini di Vendita)

### Endpoint
- **Create**: `PUT /sales/order`
- **Update**: `PUT /sales/order/{orderId}`
- **Get**: `GET /sales/order/{orderId}`
- **List**: `GET /sales/order`
- **Archive**: `DELETE /sales/order/{orderId}`

### Payload Completo per Creazione/Aggiornamento

```json
{
  "id": "50cb8b9f-7d05-4382-ab33-447eabdfee95",
  "internal_id": "SO-2026/0005",
  "customer_id": "1db931a6-ff8a-4893-b4f5-1c7722867658",
  "customer_attr": {
    "id": "1db931a6-ff8a-4893-b4f5-1c7722867658",
    "name": "MAILLE ANGIE",
    "address": "IMMEUBLE SEQUOIA ZA LA BEUCHERIE 53000 LAVAL",
    "country": "FR",
    "vat": "FR96837738103"
  },
  "default_currency": "EUR",
  "time": "2026-01-14T12:11:58.565Z",
  "expected_shipping_time": "2026-01-14T23:00:00Z",
  "shipping_address": "IMMEUBLE SEQUOIA ZA LA BEUCHERIE 53000 LAVAL - FR",
  "products": [
    {
      "id": "50690dd3-1e20-423c-b09b-0e631787d7f8",
      "extra_id": "PARSLEY 12 - 1080",
      "name": "PARSLEY 12 - 1080 - NM 3/50 100% COTTON AEGEAN COMPACT GOTS LS",
      "quantity": 2,
      "uom": "kilogram",
      "prices": {
        "currency": "EUR",
        "unit": 21,
        "vat": 0,
        "base_price": 21,
        "discount_percent": 0
      }
    }
  ],
  "status": "draft",
  "notes": "",
  "version": 1,
  "total": 42,
  "total_vat_incl": 42,
  "priority": 3
}
```

### Campi Obbligatori

| Campo | Tipo | Descrizione | Generato da |
|-------|------|-------------|-------------|
| `customer_id` | UUID | ID cliente | AI (da lista) |
| `customer_attr` | Object | Snapshot dati cliente | Funzione (da get_customer) |
| `customer_attr.id` | UUID | ID cliente | Funzione |
| `customer_attr.name` | string | Nome cliente | Funzione |
| `customer_attr.address` | string | Indirizzo | Funzione |
| `customer_attr.country` | string | Codice paese | Funzione |
| `customer_attr.vat` | string | Partita IVA | Funzione |
| `default_currency` | string | EUR, USD, GBP | Funzione (default EUR) |
| `time` | ISO string | Data/ora creazione | Funzione (new Date()) |
| `expected_shipping_time` | ISO string | Data spedizione | AI |
| `shipping_address` | string | Indirizzo spedizione | AI |
| `products` | Array | Lista prodotti | AI + Funzione |
| `products[].id` | UUID | ID riga ordine | Funzione (randomUUID) |
| `products[].extra_id` | string | CODICE prodotto (internal_id) | AI |
| `products[].name` | string | Nome completo prodotto | Funzione (da catalogo) |
| `products[].quantity` | number | Quantità | AI |
| `products[].uom` | string | Unità misura | Funzione (da catalogo) |
| `products[].prices` | Object | Prezzi | Funzione (da catalogo) |
| `products[].prices.currency` | string | EUR, USD, GBP | Funzione |
| `products[].prices.unit` | number | Prezzo unitario | Funzione |
| `products[].prices.vat` | number | IVA | Funzione |
| `products[].prices.base_price` | number | Prezzo base | Funzione |
| `products[].prices.discount_percent` | number | Sconto % | Funzione (default 0) |
| `status` | string | draft, accepted, sent | AI (default draft) |
| `version` | number | Versione documento | Funzione (1 per nuovo) |
| `total` | number | Totale ordine | Funzione (calcolato) |
| `total_vat_incl` | number | Totale IVA inclusa | Funzione (calcolato) |
| `priority` | number | Priorità (1-5) | Funzione (default 3) |

### ERRORI COMUNI DA EVITARE

1. **`extra_id` NON è l'UUID del prodotto**
   - SBAGLIATO: `"extra_id": "11368f40-729a-47ca-85d7-6b275a02f39e"`
   - CORRETTO: `"extra_id": "PARSLEY 12 - 1680"`

2. **Ogni prodotto DEVE avere un `id` (UUID)**
   - Generato con `randomUUID()` dalla funzione

3. **`customer_attr` DEVE contenere i dati del cliente**
   - Non basta passare solo `customer_id`
   - La funzione deve recuperare i dati con `get_customer` se necessario

4. **`prices` DEVE contenere TUTTI i campi**
   - `currency`, `unit`, `vat`, `base_price`, `discount_percent`

---

## Products (Prodotti)

### Endpoint
- **List**: `GET /product/product`
- **Get**: `GET /product/product/{productId}`
- **Search**: `GET /product/product?search=CODICE`

### Struttura Prodotto

```json
{
  "id": "11368f40-729a-47ca-85d7-6b275a02f39e",
  "internal_id": "PARSLEY 12 - 1680",
  "name": "PARSLEY 12 - 1680 - NM 3/50 100% COTTON AEGEAN COMPACT GOTS LS",
  "type": "purchasable",
  "uom": "kilogram",
  "categories": ["evolution"],
  "prices": {
    "currency": "EUR",
    "unit": 17,
    "vat": 0,
    "deals": [{"min_quantity": 1, "unit": 17, "category": ""}]
  }
}
```

### Mapping Prodotto -> Ordine

Quando si aggiunge un prodotto a un ordine:

| Campo Prodotto | Campo Ordine.products[] |
|----------------|-------------------------|
| `internal_id` | `extra_id` |
| `name` | `name` |
| `uom` | `uom` |
| `prices.currency` | `prices.currency` |
| `prices.unit` | `prices.unit` e `prices.base_price` |
| `prices.vat` | `prices.vat` |
| - | `id` (generato con randomUUID) |
| - | `quantity` (dall'utente) |
| - | `discount_percent` (default 0) |

---

## Customers (Clienti)

### Endpoint
- **List**: `GET /sales/customer`
- **Get**: `GET /sales/customer/{customerId}`

### Struttura Cliente

```json
{
  "id": "5572e85e-fcdd-461b-a72a-016171e0a8bc",
  "name": "MADEWELL",
  "vat_no": "n/a",
  "default_currency": "EUR",
  "addresses": [
    {
      "name": "Main",
      "address": "225 Liberty Street 19th Floor, New York, NY",
      "country": "US"
    }
  ],
  "emails": [{"name": "Main", "email": "anna.benzin@madewell.com"}],
  "phones": [{"name": "Main", "phone": "+16309814346"}]
}
```

### Mapping Cliente -> Ordine

Quando si crea un ordine per un cliente:

| Campo Cliente | Campo Ordine |
|---------------|--------------|
| `id` | `customer_id` e `customer_attr.id` |
| `name` | `customer_attr.name` |
| `addresses[0].address` | `customer_attr.address` |
| `addresses[0].country` | `customer_attr.country` |
| `vat_no` | `customer_attr.vat` |
| `default_currency` | `default_currency` |

---

## Workflow Consigliato per Creazione Ordine

### Step 1: AI riceve richiesta
```
Utente: "Crea un ordine per MADEWELL, 5kg di PARSLEY 12 - 1680, spedizione 15 febbraio"
```

### Step 2: AI estrae intent
```json
{
  "customer_name": "MADEWELL",
  "products": [{"code": "PARSLEY 12 - 1680", "quantity": 5}],
  "shipping_date": "2026-02-15"
}
```

### Step 3: AI chiama funzioni per raccogliere dati
1. `list_customers(search: "MADEWELL")` → ottiene UUID cliente
2. `get_customer(customerId: "...")` → ottiene dati completi cliente
3. `list_products(search: "PARSLEY 12 - 1680")` → ottiene dati prodotto

### Step 4: AI chiama `create_sales_order` con dati completi
```json
{
  "customer_id": "5572e85e-fcdd-461b-a72a-016171e0a8bc",
  "customer_attr": {
    "id": "5572e85e-fcdd-461b-a72a-016171e0a8bc",
    "name": "MADEWELL",
    "address": "225 Liberty Street 19th Floor, New York, NY",
    "country": "US",
    "vat": "n/a"
  },
  "expected_shipping_time": "2026-02-15T00:00:00Z",
  "shipping_address": "225 Liberty Street, 19th Floor, New York, NY, US",
  "products": [{
    "extra_id": "PARSLEY 12 - 1680",
    "name": "PARSLEY 12 - 1680 - NM 3/50 100% COTTON AEGEAN COMPACT GOTS LS",
    "quantity": 5,
    "uom": "kilogram",
    "prices": {
      "currency": "EUR",
      "unit": 17,
      "vat": 0,
      "base_price": 17,
      "discount_percent": 0
    }
  }]
}
```

### Step 5: `arkeService.createSalesOrder` costruisce payload finale
- Aggiunge `products[].id` (randomUUID)
- Calcola `total` e `total_vat_incl`
- Aggiunge `time`, `version`, `priority`
- Invia a API Arke

---

## Validazione Pre-Invio

Prima di inviare a Arke, la funzione DEVE verificare:

1. ✅ `customer_id` è un UUID valido
2. ✅ `customer_attr` contiene almeno `name`
3. ✅ Ogni prodotto ha `extra_id` (codice, non UUID)
4. ✅ Ogni prodotto ha `quantity` > 0
5. ✅ Ogni prodotto ha `prices` completo
6. ✅ `expected_shipping_time` è una data ISO valida
7. ✅ `shipping_address` non è vuoto
