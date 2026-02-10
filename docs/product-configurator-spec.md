# Product Configurator - Specifica Tecnica

## Panoramica

Il Product Configurator è un tool per generare varianti prodotto nel catalogo Arke combinando **prodotti mastro** con **codici colore** dalle cartelle colori predefinite. Permette di creare rapidamente nuovi prodotti acquistabili (purchasable) partendo da template base.

**URL:** `/configurator`

---

## Architettura

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND                                  │
│  /configurator - React + TanStack Query                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ 1. Selezione│→ │ 2. Colori   │→ │ 3. Preview  │→ Risultato  │
│  │   Prodotto  │  │   Varianti  │  │   Duplicati │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        BACKEND                                   │
│  Express.js - /api/configurator/*                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ • check-duplicates → verifica su Arke se prodotto esiste │   │
│  │ • generate-products → crea prodotti batch su Arke        │   │
│  │ • generate-custom-product → crea prodotto colore custom  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        DATABASE                                  │
│  PostgreSQL - Drizzle ORM                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐      │
│  │ colorFolders │←─│ colors       │  │ generatedProducts│      │
│  │              │  │              │  │ (tracking)       │      │
│  └──────────────┘  └──────────────┘  └──────────────────┘      │
│         ↑                                      ↑                │
│  ┌──────────────┐                              │                │
│  │masterProducts│──────────────────────────────┘                │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        ARKE API                                  │
│  External ERP System                                            │
│  • PUT /product/product → crea nuovo prodotto                   │
│  • POST /product/{id}/supplier → associa fornitore              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Modello Dati

### 1. Color Folders (Cartelle Colori)

Raggruppano i colori in famiglie predefinite.

```typescript
// shared/schema.ts
colorFolders = {
  id: serial,           // ID auto-incrementale
  code: text,           // Codice univoco (es. "GENERAL", "MERCERIZED")
  name: text,           // Nome visualizzato
  description: text     // Descrizione opzionale
}
```

**Cartelle disponibili:**
- `GENERAL` - Colori standard
- `MERCERIZED` - Colori mercerizzati
- `MELANGE` - Effetti mélange
- `JAMIRO` - Linea Jamiro
- `TART` - Linea Tart
- `VOGUE` - Linea Vogue

### 2. Colors (Colori)

Singoli codici colore con informazioni sui livelli di stock.

```typescript
colors = {
  id: serial,           // ID auto-incrementale
  code: text,           // Codice colore (es. "0040", "0190")
  name: text,           // Nome colore (opzionale)
  folderId: integer,    // FK → colorFolders.id
  stockTiers: text[]    // Array: ["STOCK_4", "STOCK_12", "STOCK_24", "STOCK_144"]
}
```

**Stock Tiers (gerarchici):**
| Tier | Significato |
|------|-------------|
| `STOCK_4` | Disponibile in 4+ kg (include anche 12, 24, 144) |
| `STOCK_12` | Disponibile in 12+ kg |
| `STOCK_24` | Disponibile in 24+ kg |
| `STOCK_144` | Disponibile solo su ordine (144+ kg) |

### 3. Master Products (Prodotti Mastro)

Template di prodotto con prezzo base e cartella colori associata.

```typescript
masterProducts = {
  id: serial,           // ID auto-incrementale
  code: text,           // Codice prodotto (es. "PARSLEY 14")
  name: text,           // Nome tecnico (es. "GLOSS NM 2/50 GOTS")
  basePrice: numeric,   // Prezzo base EUR
  uom: text,            // Unità di misura ("kilogram")
  folderId: integer,    // FK → colorFolders.id (cartella colori compatibile)
  stockTier: text,      // Tier di stock del prodotto
  category: text        // Categoria (es. "evolution")
}
```

### 4. Generated Products (Prodotti Generati)

Tracking locale dei prodotti creati su Arke.

```typescript
generatedProducts = {
  id: serial,             // ID auto-incrementale
  masterProductId: integer, // FK → masterProducts.id
  colorId: integer,       // FK → colors.id
  arkeProductId: text,    // UUID prodotto su Arke
  arkeInternalId: text,   // Codice interno Arke (es. "PARSLEY 14 - 0040")
  syncStatus: text,       // "pending" | "synced" | "partial" | "failed"
  createdAt: timestamp,
  updatedAt: timestamp
}
```

### 5. Custom Colors (Colori Custom)

Colori personalizzati creati per clienti specifici.

```typescript
customColors = {
  id: serial,
  code: text,           // Codice colore custom
  name: text,           // Nome (opzionale)
  customerId: text,     // UUID cliente Arke
  customerName: text,   // Nome cliente (per riferimento)
  createdAt: timestamp
}
```

---

## Flusso Operativo

### Step 1: Selezione Prodotto Mastro

L'utente visualizza tutti i prodotti mastro disponibili con:
- Codice e nome
- Prezzo base
- Cartella colori associata
- Numero colori totali / già generati

### Step 2: Selezione Varianti Colore

Per il prodotto mastro selezionato:
1. Sistema mostra tutti i colori della cartella associata
2. Indica quali colori sono già stati generati su Arke
3. Permette filtro per Stock Tier
4. Utente seleziona uno o più colori

**Filtri disponibili:**
- Tutti i colori
- Solo Stock (STOCK_4 e superiori)
- Solo NON generati

### Step 3: Verifica Duplicati

Prima della generazione, il sistema:
1. Chiama `POST /api/configurator/check-duplicates`
2. Per ogni colore selezionato, verifica su Arke se esiste già il prodotto
3. Mostra preview con:
   - ✅ Prodotti disponibili per creazione
   - ⚠️ Prodotti già esistenti (saltati)

### Step 4: Generazione su Arke

Per ogni prodotto da creare:

```
1. Costruisce internal_id: "{MASTER_CODE} - {COLOR_CODE}"
   Esempio: "PARSLEY 14 - 0040"

2. Costruisce name: "{MASTER_CODE} - {COLOR_CODE} - {TECHNICAL_DESC}"
   Esempio: "PARSLEY 14 - 0040 - GLOSS NM 2/50 GOTS"

3. Crea prodotto su Arke (PUT /product/product):
   {
     name: "PARSLEY 14 - 0040 - GLOSS NM 2/50 GOTS",
     type: "purchasable",
     uom: "kilogram",
     internal_id: "PARSLEY 14 - 0040",
     master_type: "PARSLEY 14",
     categories: ["0040"],
     prices: { currency: "EUR", unit: 25.00, vat: 0 },
     custom_form_values: {
       generation: 0,
       values: [{ label: "Variante", name: "variante", value: "0040" }]
     }
   }

4. Associa fornitore Turchia (POST /product/{id}/supplier):
   {
     supplier_id: "67b2e189-b9ee-42af-8aa9-ddd8bf6e2e62",  // HATFIL
     external_id: "PARSLEY 14 - 0040",
     minimum_quantity: 1,
     uom: "kilogram",
     prices: { currency: "EUR", unit: 25.00, vat: 0 }
   }

5. Salva in DB locale (generatedProducts) per tracking
```

---

## Naming Convention

| Campo | Pattern | Esempio |
|-------|---------|---------|
| `internal_id` | `{MASTER_CODE} - {COLOR_CODE}` | `PARSLEY 14 - 0040` |
| `name` | `{MASTER_CODE} - {COLOR_CODE} - {TECHNICAL_DESC}` | `PARSLEY 14 - 0040 - GLOSS NM 2/50 GOTS` |
| `master_type` | `{MASTER_CODE}` | `PARSLEY 14` |
| `categories` | `[{COLOR_CODE}]` oppure `[{COLOR_CODE}, "custom"]` | `["0040"]` o `["CUST01", "custom"]` |

---

## Colori Custom

Funzionalità per creare prodotti con codici colore personalizzati per clienti specifici.

### Differenze rispetto a colori standard:

| Aspetto | Standard | Custom |
|---------|----------|--------|
| Codice colore | Da cartella predefinita | Inserito manualmente |
| Categories | `[colorCode]` | `[colorCode, "custom"]` |
| Description | - | Nome cliente richiedente |
| Cliente | Non specificato | UUID cliente Arke |

### Flusso:

1. Utente seleziona prodotto mastro
2. Passa a tab "Colore Custom"
3. Inserisce codice colore (es. "CUST001")
4. Cerca e seleziona cliente Arke
5. Sistema genera prodotto con etichetta "custom"

---

## API Reference

### Endpoints Disponibili

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | `/api/configurator/folders` | Lista cartelle colori |
| GET | `/api/configurator/folders/:id/colors` | Colori di una cartella |
| GET | `/api/configurator/master-products` | Lista prodotti mastro |
| GET | `/api/configurator/master-products/:id` | Dettaglio con colori disponibili |
| POST | `/api/configurator/check-duplicates` | Verifica esistenza su Arke |
| POST | `/api/configurator/generate-products` | Genera batch prodotti |
| POST | `/api/configurator/generate-custom-product` | Genera prodotto custom |
| GET | `/api/configurator/generated-products` | Lista prodotti generati |
| GET | `/api/configurator/custom-colors` | Lista colori custom creati |
| POST | `/api/configurator/import` | Importa dati da CSV |

### Dettaglio Endpoints Principali

#### POST /api/configurator/check-duplicates

Verifica se i prodotti esistono già su Arke prima della generazione.

**Request:**
```json
{
  "masterProductId": 1,
  "colorIds": [5, 12, 23]
}
```

**Response:**
```json
{
  "duplicates": [
    { "colorId": 5, "colorCode": "0040", "arkeInternalId": "PARSLEY 14 - 0040", "exists": true }
  ],
  "available": [
    { "colorId": 12, "colorCode": "0190", "arkeInternalId": "PARSLEY 14 - 0190" },
    { "colorId": 23, "colorCode": "0290", "arkeInternalId": "PARSLEY 14 - 0290" }
  ],
  "masterProduct": { ... }
}
```

#### POST /api/configurator/generate-products

Genera batch di prodotti su Arke.

**Request:**
```json
{
  "masterProductId": 1,
  "colorIds": [12, 23]
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    { 
      "colorCode": "0190", 
      "arkeInternalId": "PARSLEY 14 - 0190", 
      "success": true, 
      "arkeProductId": "uuid-xxx",
      "supplierAssociated": true 
    },
    { 
      "colorCode": "0290", 
      "arkeInternalId": "PARSLEY 14 - 0290", 
      "success": true, 
      "arkeProductId": "uuid-yyy",
      "supplierAssociated": true 
    }
  ],
  "summary": { "total": 2, "success": 2, "failed": 0 }
}
```

#### POST /api/configurator/generate-custom-product

Genera singolo prodotto con colore custom per cliente specifico.

**Request:**
```json
{
  "masterProductId": 1,
  "colorCode": "CUST001",
  "customerId": "customer-uuid",
  "customerName": "MADEWELL SRL"
}
```

**Response:**
```json
{
  "success": true,
  "arkeInternalId": "PARSLEY 14 - CUST001",
  "arkeProductId": "uuid-zzz",
  "supplierAssociated": true,
  "customerName": "MADEWELL SRL"
}
```

---

## Fornitore Default

Tutti i prodotti generati vengono automaticamente associati al fornitore Turchia:

| Campo | Valore |
|-------|--------|
| ID | `67b2e189-b9ee-42af-8aa9-ddd8bf6e2e62` |
| Nome | HATFIL TEKSTİL İŞLETMELERİ A.Ş. |
| P.IVA | 4699350981 |

---

## Sync Status

| Status | Significato |
|--------|-------------|
| `pending` | In attesa di creazione |
| `synced` | Creato con successo + fornitore associato |
| `partial` | Creato ma fornitore NON associato |
| `failed` | Creazione fallita |

---

## File Coinvolti

| File | Ruolo |
|------|-------|
| `client/src/pages/configurator.tsx` | UI completa del configuratore |
| `server/routes.ts` | Endpoints API (righe 1953-2370) |
| `shared/schema.ts` | Schema database (righe 92-178) |
| `server/arkeService.ts` | Client API Arke |
