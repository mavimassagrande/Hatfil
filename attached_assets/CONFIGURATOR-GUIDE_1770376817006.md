# Guida Completa - Configuratore Prodotti Maglificio

## Panoramica

Il Configuratore è un sistema per gestire il catalogo prodotti di un maglificio (knitwear manufacturer). Permette di:

1. **Gruppi Prodotto** - Raggruppare prodotti per filato e palette colori
2. **Prodotti Master** - Template base con codice stile, prezzo, taglie e lavorazioni
3. **Varianti** - Combinazioni colore/taglia generate automaticamente in Arke ERP
4. **Scheda Tecnica** - Dettagli tecnici (filato, composizione, lavorazione) con misure per taglia
5. **Piano Lavorazioni** - Fasi di produzione con materiali associati
6. **Sincronizzazione** - Quando il master cambia, le varianti vengono aggiornate

---

## Architettura

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                    │
│                                                                          │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────────────┐   │
│  │  Configurator│  │  Master Product   │  │  Pagina Prodotti Arke   │   │
│  │  (lista)     │──▶  Detail (tabs)    │  │  (lista varianti)       │   │
│  └──────────────┘  └──────────────────┘  └──────────────────────────┘   │
│         │                   │                                            │
│    ┌────┴────┐    ┌────────┼────────────────────┐                       │
│    │ Gruppi  │    │        │         │          │                        │
│    │ Prodotto│    ▼        ▼         ▼          ▼                       │
│    └─────────┘  Panoram. Lavoraz.  Varianti  Scheda                    │
│                                               Tecnica                   │
└───────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                              BACKEND                                     │
│                                                                          │
│  ┌──────────────────┐    ┌──────────────────┐                           │
│  │ /api/configurator│    │  /api/arke/*     │                           │
│  │ (PostgreSQL)     │    │  (proxy → Arke)  │                           │
│  └──────────────────┘    └──────────────────┘                           │
│         │                         │                                      │
│    ┌────┴────┐              ┌─────┴─────┐                               │
│    │ groups  │              │ Arke ERP  │                               │
│    │ master  │              │ Products  │                               │
│    │ variants│              │ Phases    │                               │
│    └─────────┘              │ Materials │                               │
│                             └───────────┘                               │
└───────────────────────────────────────────────────────────────────────────┘
```

**Dualità dei dati:**
- I **Gruppi**, **Master Products** e **Varianti generate** sono salvati nel database PostgreSQL locale
- I **prodotti Arke**, **fasi di produzione** e **materiali** risiedono in Arke ERP (API esterna)
- Il Master Product ha un campo `arkeProductId` che lo collega al prodotto creato in Arke

---

## 0. Autenticazione e Proxy Arke

### Flusso Autenticazione

Tutte le API `/api/configurator/*` e `/api/arke/*` richiedono autenticazione tramite sessione.

```
Login → POST /api/login → Arke /login → accessToken → Sessione
```

### POST /api/login

```typescript
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await fetch(`${ARKE_BASE_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await result.json();
  // data.accessToken → salvato in req.session.arkeToken
  req.session.arkeToken = data.accessToken;
  req.session.user = data.user;
});
```

### Middleware requireAuth

```typescript
function requireAuth(req, res, next) {
  if (!req.session?.arkeToken) {
    return res.status(401).json({ error: "Non autenticato" });
  }
  next();
}
```

### Funzione arkeRequest (proxy Arke)

Wrapper per chiamate Arke con token dalla sessione e normalizzazione risposte.

```typescript
async function arkeRequest(endpoint: string, options: RequestInit = {}) {
  const token = getArkeToken();  // Dall'AsyncLocalStorage o dalla sessione
  const url = `${ARKE_BASE_URL}${endpoint}`;
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json();
  
  // Normalizzazione: Arke restituisce items[], data[], o content[]
  if (data?.items && Array.isArray(data.items)) return data.items;
  if (data?.data && Array.isArray(data.data)) return data.data;
  if (data?.content && Array.isArray(data.content)) return data.content;
  return data;
}
```

### Mapping Endpoint Arke ERP Effettivi

| Endpoint Backend | Endpoint Arke ERP | Metodo |
|---|---|---|
| GET /api/arke/production-phases | /product/production-phase | GET |
| GET /api/arke/raw-materials | /supply/raw-material/raw-material | GET |
| GET /api/arke/suppliers | /supply/supplier/supplier | GET |
| PUT /api/arke/suppliers | /supply/supplier/supplier | PUT |
| GET /api/arke/warehouses | /supply/warehouse/warehouse | GET |
| Creazione prodotto (interno) | /product/product | PUT |
| Aggiornamento prodotto (interno) | /product/product/{arkeProductId} | PUT |
| Lettura prodotto (interno) | /product/product/{arkeProductId} | GET |

**Variabili Ambiente:**
```env
ARKE_BASE_URL=https://your-arke.com/api   # Base URL Arke
ARKE_TOKEN=your-bearer-token               # Token (alternativo alla sessione)
SESSION_SECRET=your-session-secret          # Per express-session
DATABASE_URL=postgresql://...              # PostgreSQL
```

---

## 1. Schema Database (PostgreSQL + Drizzle ORM)

### Tabella: product_groups

Raggruppa prodotti con stessa composizione filato e palette colori.

```typescript
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp } from "drizzle-orm/pg-core";

export const productGroups = pgTable("product_groups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),       // es. "GRP-001"
  name: text("name").notNull(),                // es. "Cashmere Collection"
  yarn: text("yarn"),                          // es. "Cashmere 100%"
  colors: text("colors").array().notNull().default(sql`'{}'::text[]`),  // palette colori disponibili
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
```

**Esempio dati:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "code": "CASH-FW25",
  "name": "Cashmere FW25",
  "yarn": "Cashmere 100% GG 12",
  "colors": ["Bianco", "Nero", "Grigio Chiaro", "Blu Navy", "Cammello"]
}
```

### Tabella: master_products

Template del prodotto con tutte le specifiche. Il campo `arkeProductId` lo collega ad Arke.

```typescript
import { pgTable, text, varchar, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";

export const masterProducts = pgTable("master_products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  arkeProductId: text("arke_product_id"),           // UUID del prodotto in Arke ERP
  styleCode: text("style_code").notNull().unique(),  // es. "FW25-PULL-001"
  styleName: text("style_name").notNull(),           // es. "Pullover Girocollo"
  productType: text("product_type").notNull(),       // es. "pullover", "cardigan", "gilet"
  galgaImage: text("galga_image"),                   // URL immagine galga/campione
  groupId: varchar("group_id").references(() => productGroups.id),  // FK al gruppo
  basePrice: numeric("base_price", { precision: 10, scale: 2 }).notNull(),  // prezzo base
  currency: text("currency").notNull().default("EUR"),
  description: text("description"),
  sizes: text("sizes").array().notNull().default(sql`'{}'::text[]`),  // es. ["XS","S","M","L","XL"]
  plan: jsonb("plan").notNull().default(sql`'[]'::jsonb`),           // fasi di lavorazione
  rawMaterials: jsonb("raw_materials").notNull().default(sql`'[]'::jsonb`),  // materiali grezzi
  imageUrl: text("image_url"),                       // URL immagine prodotto (Object Storage)
  technicalDetails: jsonb("technical_details").notNull().default(sql`'{}'::jsonb`),  // scheda tecnica
  measurements: jsonb("measurements").notNull().default(sql`'{}'::jsonb`),           // tabella misure
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
```

**Esempio dati:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440010",
  "arkeProductId": "arke-uuid-product-123",
  "styleCode": "FW25-PULL-001",
  "styleName": "Pullover Girocollo Cashmere",
  "productType": "pullover",
  "groupId": "550e8400-e29b-41d4-a716-446655440001",
  "basePrice": "185.00",
  "currency": "EUR",
  "description": "Pullover girocollo in cashmere puro",
  "sizes": ["XS", "S", "M", "L", "XL"],
  "plan": [
    {
      "operator": "and",
      "processes": [
        {
          "properties": {
            "id": "phase-uuid-1",
            "name": "Tessitura",
            "description": "Tessitura corpo e maniche",
            "duration": 2
          },
          "requirements": {
            "raw_materials": [
              {
                "id": "mat-uuid-1",
                "extra_id": "CASH-001",
                "name": "Cashmere filato nm 28",
                "quantity": 0.35,
                "uom": "kilogram"
              }
            ]
          }
        }
      ]
    }
  ],
  "rawMaterials": [],
  "technicalDetails": {
    "filato": "Cashmere 100%",
    "composizione": "100% Cashmere",
    "finezza": "GG 12",
    "lavorazione": "Pullover girocollo classico con costa 2x2",
    "fondo": "Jersey",
    "polsi": "Costa 2x2 h.7cm",
    "collo": "Girocollo con costa 2x2 h.3cm",
    "scollo": "Girocollo",
    "tasche": "",
    "bottoni": "",
    "finta": "",
    "lavaggio": "Lavaggio a mano 30°C - Non candeggiare",
    "noteVarie": "Peso medio: 280g taglia M",
    "pesoMedio": "280g"
  },
  "measurements": {
    "rows": [
      { "name": "Lunghezza totale", "values": { "XS": "62", "S": "64", "M": "66", "L": "68", "XL": "70" } },
      { "name": "Larghezza spalle", "values": { "XS": "40", "S": "42", "M": "44", "L": "46", "XL": "48" } },
      { "name": "Lunghezza manica", "values": { "XS": "58", "S": "60", "M": "62", "L": "63", "XL": "64" } },
      { "name": "Giro petto", "values": { "XS": "92", "S": "96", "M": "100", "L": "106", "XL": "112" } }
    ]
  }
}
```

### Tabella: generated_variants

Tiene traccia delle varianti colore/taglia create in Arke per ogni master.

```typescript
export const generatedVariants = pgTable("generated_variants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  masterProductId: varchar("master_product_id").notNull().references(() => masterProducts.id),
  colorCode: text("color_code").notNull(),        // es. "Bianco", "Nero"
  size: text("size").notNull(),                    // es. "M", "L"
  arkeProductId: text("arke_product_id").notNull(), // UUID prodotto variante in Arke
  arkeInternalId: text("arke_internal_id").notNull(), // es. "FW25-PULL-001 - Bianco - M"
  syncStatus: text("sync_status").notNull().default("synced"),
  // syncStatus possibili: "synced" | "needs_update" | "failed"
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
```

**Esempio dati:**
```json
{
  "id": "variant-uuid-001",
  "masterProductId": "550e8400-e29b-41d4-a716-446655440010",
  "colorCode": "Bianco",
  "size": "M",
  "arkeProductId": "arke-variant-uuid-001",
  "arkeInternalId": "FW25-PULL-001 - Bianco - M",
  "syncStatus": "synced"
}
```

### Relazioni

```typescript
import { relations } from "drizzle-orm";

export const productGroupsRelations = relations(productGroups, ({ many }) => ({
  masterProducts: many(masterProducts),
}));

export const masterProductsRelations = relations(masterProducts, ({ one, many }) => ({
  group: one(productGroups, {
    fields: [masterProducts.groupId],
    references: [productGroups.id],
  }),
  generatedVariants: many(generatedVariants),
}));

export const generatedVariantsRelations = relations(generatedVariants, ({ one }) => ({
  masterProduct: one(masterProducts, {
    fields: [generatedVariants.masterProductId],
    references: [masterProducts.id],
  }),
}));
```

---

## 2. Schema Validazione Zod

### Insert/Update Schemas

```typescript
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Product Groups
export const insertProductGroupSchema = createInsertSchema(productGroups).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const updateProductGroupSchema = insertProductGroupSchema.partial();
export type InsertProductGroup = z.infer<typeof insertProductGroupSchema>;
export type UpdateProductGroup = z.infer<typeof updateProductGroupSchema>;
export type ProductGroup = typeof productGroups.$inferSelect;

// Master Products
export const insertMasterProductSchema = createInsertSchema(masterProducts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const updateMasterProductSchema = insertMasterProductSchema.partial();
export type InsertMasterProduct = z.infer<typeof insertMasterProductSchema>;
export type UpdateMasterProduct = z.infer<typeof updateMasterProductSchema>;
export type MasterProduct = typeof masterProducts.$inferSelect;

// Generated Variants
export const insertGeneratedVariantSchema = createInsertSchema(generatedVariants).omit({
  id: true,
  lastSyncedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertGeneratedVariant = z.infer<typeof insertGeneratedVariantSchema>;
export type GeneratedVariant = typeof generatedVariants.$inferSelect;
```

### Schemi per dati embedded (JSONB)

```typescript
// Fase del piano di lavorazione (formato interno semplificato)
export const planPhaseSchema = z.object({
  stepIndex: z.number(),
  processes: z.array(z.object({
    name: z.string(),
    productionPhaseId: z.string().optional(),
    properties: z.record(z.unknown()).optional(),
  })),
});

// Materiale grezzo
export const rawMaterialSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  quantity: z.number(),
  uom: z.string(),
});

export type PlanPhase = z.infer<typeof planPhaseSchema>;
export type RawMaterial = z.infer<typeof rawMaterialSchema>;

// Scheda Tecnica (campi specifici maglieria)
export const technicalDetailsSchema = z.object({
  lavorazione: z.string().optional(),    // descrizione lavorazione completa
  filato: z.string().optional(),          // tipo di filato
  composizione: z.string().optional(),    // composizione fibra (es. "80% Lana 20% Cashmere")
  finezza: z.string().optional(),         // finezza macchina (es. "GG 12")
  pesoMedio: z.string().optional(),       // peso medio capo finito
  fondo: z.string().optional(),           // tipo di punto fondo
  polsi: z.string().optional(),           // lavorazione polsi
  collo: z.string().optional(),           // tipo di collo
  scollo: z.string().optional(),          // tipo di scollo
  finta: z.string().optional(),           // finta/allacciatura
  tasche: z.string().optional(),          // descrizione tasche
  bottoni: z.string().optional(),         // tipo/numero bottoni
  noteVarie: z.string().optional(),       // note aggiuntive
  lavaggio: z.string().optional(),        // istruzioni lavaggio
});

// Tabella Misure
export const measurementRowSchema = z.object({
  name: z.string(),                       // es. "Lunghezza totale"
  values: z.record(z.string(), z.string()), // es. { "S": "64", "M": "66" }
});

export const measurementsSchema = z.object({
  rows: z.array(measurementRowSchema),
});

export type TechnicalDetails = z.infer<typeof technicalDetailsSchema>;
export type MeasurementRow = z.infer<typeof measurementRowSchema>;
export type Measurements = z.infer<typeof measurementsSchema>;
```

---

## 3. Storage Interface (CRUD Operations)

```typescript
export interface IStorage {
  // ---- Product Groups ----
  getProductGroups(): Promise<ProductGroup[]>;
  getProductGroup(id: string): Promise<ProductGroup | undefined>;
  createProductGroup(group: InsertProductGroup): Promise<ProductGroup>;
  createProductGroupWithId(group: InsertProductGroup & { id: string }): Promise<ProductGroup>;
  updateProductGroup(id: string, group: Partial<InsertProductGroup>): Promise<ProductGroup | undefined>;
  deleteProductGroup(id: string): Promise<boolean>;
  
  // ---- Master Products ----
  getMasterProducts(): Promise<MasterProduct[]>;
  getMasterProduct(id: string): Promise<MasterProduct | undefined>;
  getMasterProductByStyleCode(styleCode: string): Promise<MasterProduct | undefined>;
  createMasterProduct(product: InsertMasterProduct): Promise<MasterProduct>;
  createMasterProductWithId(product: InsertMasterProduct & { id: string }): Promise<MasterProduct>;
  updateMasterProduct(id: string, product: Partial<InsertMasterProduct>): Promise<MasterProduct | undefined>;
  deleteMasterProduct(id: string): Promise<boolean>;
  
  // ---- Generated Variants ----
  getGeneratedVariants(): Promise<GeneratedVariant[]>;
  getGeneratedVariantsByMaster(masterProductId: string): Promise<GeneratedVariant[]>;
  getGeneratedVariant(id: string): Promise<GeneratedVariant | undefined>;
  createGeneratedVariant(variant: InsertGeneratedVariant): Promise<GeneratedVariant>;
  createGeneratedVariantWithId(variant: InsertGeneratedVariant & { id: string }): Promise<GeneratedVariant>;
  updateGeneratedVariantSyncStatus(id: string, status: string): Promise<GeneratedVariant | undefined>;
  markVariantsForSync(masterProductId: string): Promise<number>;
}
```

### Implementazione DatabaseStorage

```typescript
import { eq } from "drizzle-orm";
import { db } from "./db";

export class DatabaseStorage implements IStorage {
  // Product Groups
  async getProductGroups(): Promise<ProductGroup[]> {
    return db.select().from(productGroups);
  }

  async getProductGroup(id: string): Promise<ProductGroup | undefined> {
    const [group] = await db.select().from(productGroups).where(eq(productGroups.id, id));
    return group;
  }

  async createProductGroup(group: InsertProductGroup): Promise<ProductGroup> {
    const [created] = await db.insert(productGroups).values(group).returning();
    return created;
  }

  async createProductGroupWithId(group: InsertProductGroup & { id: string }): Promise<ProductGroup> {
    const [created] = await db.insert(productGroups).values(group).returning();
    return created;
  }

  async updateProductGroup(id: string, group: Partial<InsertProductGroup>): Promise<ProductGroup | undefined> {
    const [updated] = await db
      .update(productGroups)
      .set({ ...group, updatedAt: new Date() })
      .where(eq(productGroups.id, id))
      .returning();
    return updated;
  }

  async deleteProductGroup(id: string): Promise<boolean> {
    const result = await db.delete(productGroups).where(eq(productGroups.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Master Products
  async getMasterProducts(): Promise<MasterProduct[]> {
    return db.select().from(masterProducts);
  }

  async getMasterProduct(id: string): Promise<MasterProduct | undefined> {
    const [product] = await db.select().from(masterProducts).where(eq(masterProducts.id, id));
    return product;
  }

  async getMasterProductByStyleCode(styleCode: string): Promise<MasterProduct | undefined> {
    const [product] = await db.select().from(masterProducts).where(eq(masterProducts.styleCode, styleCode));
    return product;
  }

  async createMasterProduct(product: InsertMasterProduct): Promise<MasterProduct> {
    const [created] = await db.insert(masterProducts).values(product).returning();
    return created;
  }

  async createMasterProductWithId(product: InsertMasterProduct & { id: string }): Promise<MasterProduct> {
    const [created] = await db.insert(masterProducts).values(product).returning();
    return created;
  }

  async updateMasterProduct(id: string, product: Partial<InsertMasterProduct>): Promise<MasterProduct | undefined> {
    const [updated] = await db
      .update(masterProducts)
      .set({ ...product, updatedAt: new Date() })
      .where(eq(masterProducts.id, id))
      .returning();
    return updated;
  }

  async deleteMasterProduct(id: string): Promise<boolean> {
    const result = await db.delete(masterProducts).where(eq(masterProducts.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Generated Variants
  async getGeneratedVariants(): Promise<GeneratedVariant[]> {
    return db.select().from(generatedVariants);
  }

  async getGeneratedVariantsByMaster(masterProductId: string): Promise<GeneratedVariant[]> {
    return db.select().from(generatedVariants)
      .where(eq(generatedVariants.masterProductId, masterProductId));
  }

  async getGeneratedVariant(id: string): Promise<GeneratedVariant | undefined> {
    const [variant] = await db.select().from(generatedVariants).where(eq(generatedVariants.id, id));
    return variant;
  }

  async createGeneratedVariant(variant: InsertGeneratedVariant): Promise<GeneratedVariant> {
    const [created] = await db.insert(generatedVariants).values(variant).returning();
    return created;
  }

  async createGeneratedVariantWithId(variant: InsertGeneratedVariant & { id: string }): Promise<GeneratedVariant> {
    const [created] = await db.insert(generatedVariants).values(variant).returning();
    return created;
  }

  async updateGeneratedVariantSyncStatus(id: string, status: string): Promise<GeneratedVariant | undefined> {
    const [updated] = await db
      .update(generatedVariants)
      .set({ syncStatus: status, updatedAt: new Date() })
      .where(eq(generatedVariants.id, id))
      .returning();
    return updated;
  }

  // Marca TUTTE le varianti di un master come "needs_update"
  async markVariantsForSync(masterProductId: string): Promise<number> {
    const result = await db
      .update(generatedVariants)
      .set({ syncStatus: "needs_update", updatedAt: new Date() })
      .where(eq(generatedVariants.masterProductId, masterProductId));
    return result.rowCount ?? 0;
  }
}

export const storage = new DatabaseStorage();
```

---

## 4. Struttura Dati Arke ERP

### Piano Lavorazioni (Arke Plan)

Il piano di produzione in Arke segue questa struttura specifica:

```typescript
// Struttura che Arke si aspetta nel campo "plan" del prodotto
interface ArkePlanPhase {
  operator: 'and' | 'or' | 'xor';    // relazione tra processi
  processes: ArkePlanProcess[];
}

interface ArkePlanProcess {
  properties: {
    id: string;           // UUID della fase di produzione (da /product/production-phase)
    name: string;         // Nome della fase (es. "Tessitura", "Cucito", "Lavaggio")
    description: string;  // Descrizione dettagliata
    duration: number;     // Durata in ore (0 = non specificata)
  };
  requirements?: {
    raw_materials?: ArkePlanMaterial[];  // Materiali necessari per questa fase
  };
}

interface ArkePlanMaterial {
  id: string;             // UUID del materiale in Arke (raw-material)
  extra_id: string;       // Codice esterno materiale
  name: string;           // Nome materiale
  quantity: number;        // Quantità necessaria
  uom: string;            // Unità di misura (kilogram, unit, meter, etc.)
}
```

**Esempio piano completo:**
```json
[
  {
    "operator": "and",
    "processes": [
      {
        "properties": {
          "id": "phase-uuid-tessitura",
          "name": "Tessitura",
          "description": "Tessitura corpo, maniche e collo su macchina rettilinea GG 12",
          "duration": 2
        },
        "requirements": {
          "raw_materials": [
            {
              "id": "mat-uuid-cashmere",
              "extra_id": "CASH-NM28",
              "name": "Cashmere filato Nm 28",
              "quantity": 0.35,
              "uom": "kilogram"
            }
          ]
        }
      },
      {
        "properties": {
          "id": "phase-uuid-cucito",
          "name": "Cucito/Confezione",
          "description": "Cucito corpo, inserimento maniche, rifinitura collo",
          "duration": 1.5
        }
      },
      {
        "properties": {
          "id": "phase-uuid-lavaggio",
          "name": "Lavaggio e Stiratura",
          "description": "Lavaggio industriale e stiratura a vapore",
          "duration": 0.5
        }
      }
    ]
  }
]
```

### Prodotto Arke (campi obbligatori per PUT)

Quando si crea o aggiorna un prodotto in Arke, **tutti** questi campi sono obbligatori:

```typescript
interface ArkeProductPayload {
  name: string;             // Nome prodotto
  internal_id: string;      // Codice interno univoco
  master_type: string;      // Codice stile master (per raggruppamento)
  type: 'producible';       // Tipo prodotto
  uom: 'unit';             // Unità di misura
  version: number;          // Versione (per concurrency control)
  categories: string[];     // Categorie (es. ["pullover"])
  description: string;      // Descrizione
  prices: {
    currency: string;       // "EUR"
    unit: number;           // Prezzo unitario
    deals: {
      min_quantity: number;
      unit: number;
      category: string;    // es. "Prezzo unità"
    }[];
    vat: number;            // IVA (es. 22)
  };
  attributes: Record<string, string>;  // Attributi custom (es. { Colore: "Bianco", Taglia: "M" })
  plan: ArkePlanPhase[];    // Piano lavorazioni
  raw_materials: any[];     // Materiali grezzi
}
```

---

## 5. Endpoint API Backend

### 5.1 Gruppi Prodotto

#### GET /api/configurator/groups
Lista tutti i gruppi prodotto.

**Response:**
```json
[
  {
    "id": "uuid",
    "code": "CASH-FW25",
    "name": "Cashmere FW25",
    "yarn": "Cashmere 100% GG 12",
    "colors": ["Bianco", "Nero", "Grigio"],
    "createdAt": "2025-01-15T00:00:00Z",
    "updatedAt": "2025-01-15T00:00:00Z"
  }
]
```

#### GET /api/configurator/groups/:id
Dettaglio singolo gruppo.

#### POST /api/configurator/groups
Crea nuovo gruppo.

**Request:**
```json
{
  "code": "CASH-FW25",
  "name": "Cashmere FW25",
  "yarn": "Cashmere 100% GG 12",
  "colors": ["Bianco", "Nero", "Grigio"]
}
```

#### PUT /api/configurator/groups/:id
Aggiorna gruppo esistente (tutti i campi sono opzionali).

#### DELETE /api/configurator/groups/:id
Elimina gruppo.

---

### 5.2 Master Products

#### GET /api/configurator/master-products
Lista tutti i prodotti master.

**Response:**
```json
[
  {
    "id": "uuid",
    "arkeProductId": "arke-uuid",
    "styleCode": "FW25-PULL-001",
    "styleName": "Pullover Girocollo",
    "productType": "pullover",
    "groupId": "group-uuid",
    "basePrice": "185.00",
    "currency": "EUR",
    "description": "...",
    "sizes": ["XS", "S", "M", "L", "XL"],
    "plan": [],
    "rawMaterials": [],
    "imageUrl": null,
    "technicalDetails": {},
    "measurements": {},
    "createdAt": "...",
    "updatedAt": "..."
  }
]
```

#### GET /api/configurator/master-products/:id
Dettaglio singolo master product.

#### GET /api/configurator/master-products/:id/arke-details
Dettaglio master con dati aggiuntivi da Arke ERP.

**Response:**
```json
{
  "id": "uuid",
  "styleCode": "FW25-PULL-001",
  "arkeProductId": "arke-uuid",
  "arkeProduct": {
    "id": "arke-uuid",
    "name": "Pullover Girocollo",
    "internal_id": "FW25-PULL-001",
    "type": "producible",
    "version": 3,
    "plan": [...],
    "prices": {...}
  },
  "...restCampiLocali"
}
```

#### POST /api/configurator/master-products
Crea nuovo master product. **Prima crea il prodotto in Arke, poi salva localmente.**

**Request:**
```json
{
  "styleCode": "FW25-PULL-001",
  "styleName": "Pullover Girocollo",
  "productType": "pullover",
  "groupId": "group-uuid",
  "basePrice": "185.00",
  "currency": "EUR",
  "description": "Pullover girocollo in cashmere puro",
  "sizes": ["XS", "S", "M", "L", "XL"]
}
```

**Logica backend (IMPORTANTE):**
```typescript
app.post('/api/configurator/master-products', requireAuth, async (req, res) => {
  // 1. Valida input
  const parsed = insertMasterProductSchema.safeParse(req.body);
  
  // 2. PRIMA: Crea prodotto in Arke
  const arkeProduct = await arkeRequest('/product/product', {
    method: 'PUT',
    body: JSON.stringify({
      name: parsed.data.styleName,
      internal_id: parsed.data.styleCode,
      master_type: parsed.data.styleCode,  // Il master_type = styleCode per raggruppare varianti
      type: 'producible',
      uom: 'unit',
      version: 1,
      attributes: {},
      categories: [parsed.data.productType],
      description: parsed.data.description || '',
      prices: {
        currency: parsed.data.currency || 'EUR',
        unit: parseFloat(parsed.data.basePrice),
        deals: [{
          min_quantity: 1,
          unit: parseFloat(parsed.data.basePrice),
          category: 'Prezzo unità',
        }],
        vat: 22,
      },
      plan: [],
      raw_materials: [],
    }),
  });

  // 3. POI: Salva localmente con riferimento Arke
  const product = await storage.createMasterProduct({
    ...parsed.data,
    arkeProductId: arkeProduct.id,  // Collegamento!
  });
  
  res.status(201).json(product);
});
```

#### PUT /api/configurator/master-products/:id
Aggiorna master product locale. **Marca automaticamente tutte le varianti per sincronizzazione.**

**Request (tutti i campi opzionali):**
```json
{
  "styleName": "Pullover Girocollo Updated",
  "basePrice": "195.00",
  "sizes": ["XS", "S", "M", "L", "XL", "XXL"],
  "technicalDetails": { "filato": "Cashmere 100%" }
}
```

**Logica backend:**
```typescript
app.put('/api/configurator/master-products/:id', requireAuth, async (req, res) => {
  const parsed = updateMasterProductSchema.safeParse(req.body);
  const product = await storage.updateMasterProduct(req.params.id, parsed.data);
  
  // IMPORTANTE: Marca TUTTE le varianti come "needs_update"
  const markedCount = await storage.markVariantsForSync(req.params.id);
  
  res.json({ ...product, variantsMarkedForSync: markedCount });
});
```

#### DELETE /api/configurator/master-products/:id
Elimina master product locale (non elimina da Arke).

---

### 5.3 Piano Lavorazioni

#### PUT /api/configurator/master-products/:id/plan
Aggiorna il piano di lavorazione. **Aggiorna sia localmente che in Arke.**

**Request:**
```json
{
  "plan": [
    {
      "operator": "and",
      "processes": [
        {
          "properties": {
            "id": "phase-uuid-tessitura",
            "name": "Tessitura",
            "description": "Tessitura corpo e maniche",
            "duration": 2
          },
          "requirements": {
            "raw_materials": [
              {
                "id": "mat-uuid",
                "extra_id": "CASH-001",
                "name": "Cashmere Nm 28",
                "quantity": 0.35,
                "uom": "kilogram"
              }
            ]
          }
        }
      ]
    }
  ]
}
```

**Logica backend (IMPORTANTE - dual update):**
```typescript
app.put('/api/configurator/master-products/:id/plan', requireAuth, async (req, res) => {
  const { plan } = req.body;
  
  // 1. Recupera il prodotto locale
  const product = await storage.getMasterProduct(req.params.id);
  
  // 2. Recupera il prodotto Arke corrente (serve la version per concurrency)
  const arkeProduct = await arkeRequest(`/product/product/${product.arkeProductId}`);
  
  // 3. Aggiorna in Arke (DEVE includere TUTTI i campi obbligatori!)
  await arkeRequest(`/product/product/${product.arkeProductId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: arkeProduct.name,
      internal_id: arkeProduct.internal_id,
      type: arkeProduct.type,
      uom: arkeProduct.uom,
      categories: arkeProduct.categories,
      prices: arkeProduct.prices,
      attributes: arkeProduct.attributes,
      description: arkeProduct.description,
      version: arkeProduct.version,         // Concurrency control!
      plan,                                  // Il nuovo piano
    }),
  });
  
  // 4. Aggiorna localmente
  const updated = await storage.updateMasterProduct(req.params.id, { plan });
  
  // 5. Marca varianti per sync
  await storage.markVariantsForSync(req.params.id);
  
  res.json(updated);
});
```

---

### 5.4 Scheda Tecnica

#### PUT /api/configurator/master-products/:id/technical-sheet
Salva scheda tecnica (dettagli tecnici + misure + immagine).

**Request:**
```json
{
  "imageUrl": "path/to/image.jpg",
  "technicalDetails": {
    "filato": "Cashmere 100%",
    "composizione": "100% Cashmere",
    "finezza": "GG 12",
    "lavorazione": "Pullover girocollo classico",
    "fondo": "Jersey",
    "polsi": "Costa 2x2 h.7cm",
    "collo": "Girocollo",
    "scollo": "Girocollo",
    "finta": "",
    "tasche": "",
    "bottoni": "",
    "lavaggio": "Lavaggio a mano 30°C",
    "noteVarie": "Peso medio: 280g",
    "pesoMedio": "280g"
  },
  "measurements": {
    "rows": [
      {
        "name": "Lunghezza totale",
        "values": { "XS": "62", "S": "64", "M": "66", "L": "68", "XL": "70" }
      },
      {
        "name": "Larghezza spalle",
        "values": { "XS": "40", "S": "42", "M": "44", "L": "46", "XL": "48" }
      }
    ]
  }
}
```

**Logica backend:**
```typescript
app.put('/api/configurator/master-products/:id/technical-sheet', requireAuth, async (req, res) => {
  const { imageUrl, technicalDetails, measurements } = req.body;
  
  const updateData: Partial<InsertMasterProduct> = {};
  if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
  if (technicalDetails !== undefined) updateData.technicalDetails = technicalDetails;
  if (measurements !== undefined) updateData.measurements = measurements;
  
  const product = await storage.updateMasterProduct(req.params.id, updateData);
  res.json(product);
});
```

---

### 5.5 Generazione Varianti

#### GET /api/configurator/master-products/:id/variants
Lista varianti di un master product.

**Response:**
```json
[
  {
    "id": "variant-uuid",
    "masterProductId": "master-uuid",
    "colorCode": "Bianco",
    "size": "M",
    "arkeProductId": "arke-variant-uuid",
    "arkeInternalId": "FW25-PULL-001 - Bianco - M",
    "syncStatus": "synced",
    "lastSyncedAt": "2025-01-15T00:00:00Z"
  }
]
```

#### POST /api/configurator/generate-variants
Genera varianti colore/taglia in Arke. **Salta combinazioni già esistenti.**

**Request:**
```json
{
  "masterProductId": "master-uuid",
  "colors": ["Bianco", "Nero", "Grigio"],
  "sizes": ["S", "M", "L"]
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    { "color": "Bianco", "size": "S", "success": true, "arkeProductId": "arke-uuid-1" },
    { "color": "Bianco", "size": "M", "success": true, "skipped": true },
    { "color": "Nero", "size": "S", "success": false, "error": "Arke API error" }
  ],
  "totalGenerated": 7,
  "totalSkipped": 1,
  "totalFailed": 1
}
```

**Logica backend COMPLETA:**
```typescript
app.post('/api/configurator/generate-variants', requireAuth, async (req, res) => {
  const { masterProductId, colors, sizes } = req.body;

  const masterProduct = await storage.getMasterProduct(masterProductId);
  
  // 1. Carica varianti esistenti per skip duplicati
  const existingVariants = await storage.getGeneratedVariantsByMaster(masterProductId);
  const existingCombinations = new Set(
    existingVariants.map(v => `${v.colorCode}-${v.size}`)
  );

  const results = [];

  // 2. Loop colori x taglie
  for (const color of colors) {
    for (const size of sizes) {
      // 2a. Skip se già esiste
      if (existingCombinations.has(`${color}-${size}`)) {
        results.push({ color, size, success: true, skipped: true });
        continue;
      }
      
      // 2b. Genera internal_id e nome variante
      const arkeInternalId = `${masterProduct.styleCode} - ${color} - ${size}`;
      const arkeName = `${masterProduct.styleName} - ${color} - ${size}`;

      try {
        // 2c. Crea prodotto variante in Arke (eredita piano e materiali dal master)
        const arkeProduct = await arkeRequest('/product/product', {
          method: 'PUT',
          body: JSON.stringify({
            name: arkeName,
            internal_id: arkeInternalId,
            master_type: masterProduct.styleCode,   // Raggruppamento!
            type: 'producible',
            uom: 'unit',
            categories: [masterProduct.productType],
            description: masterProduct.description || '',
            version: 1,
            prices: {
              currency: masterProduct.currency,
              unit: parseFloat(masterProduct.basePrice),
              deals: [{
                min_quantity: 1,
                unit: parseFloat(masterProduct.basePrice),
                category: 'Prezzo unità',
              }],
              vat: 22,
            },
            attributes: {
              Colore: color,        // Attributo specifico variante
              Taglia: size,         // Attributo specifico variante
            },
            plan: masterProduct.plan || [],              // Ereditato dal master
            raw_materials: masterProduct.rawMaterials || [],  // Ereditato dal master
          }),
        });

        // 2d. Salva variante locale
        await storage.createGeneratedVariant({
          masterProductId,
          colorCode: color,
          size,
          arkeProductId: arkeProduct.id,
          arkeInternalId,
          syncStatus: 'synced',
        });

        results.push({ color, size, success: true, arkeProductId: arkeProduct.id });
      } catch (error) {
        results.push({ color, size, success: false, error: error.message });
      }
    }
  }

  res.json({
    success: results.filter(r => !r.success).length === 0,
    results,
    totalGenerated: results.filter(r => r.success && !r.skipped).length,
    totalSkipped: results.filter(r => r.skipped).length,
    totalFailed: results.filter(r => !r.success).length,
  });
});
```

---

### 5.6 Sincronizzazione Varianti

#### POST /api/configurator/sync-variants
Sincronizza varianti con status "needs_update" o "failed" aggiornando piano e materiali dal master.

**Request:**
```json
{
  "masterProductId": "master-uuid"
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    { "variantId": "variant-uuid-1", "success": true },
    { "variantId": "variant-uuid-2", "success": false, "error": "Arke timeout" }
  ],
  "totalSynced": 8,
  "totalFailed": 1
}
```

**Logica backend:**
```typescript
app.post('/api/configurator/sync-variants', requireAuth, async (req, res) => {
  const { masterProductId } = req.body;
  const masterProduct = await storage.getMasterProduct(masterProductId);
  
  // 1. Filtra solo varianti che necessitano aggiornamento
  const variants = await storage.getGeneratedVariantsByMaster(masterProductId);
  const needsUpdate = variants.filter(v => 
    v.syncStatus === 'needs_update' || v.syncStatus === 'failed'
  );

  const results = [];

  for (const variant of needsUpdate) {
    try {
      // 2. Recupera prodotto Arke corrente (per version e altri campi)
      const existingProduct = await arkeRequest(`/product/product/${variant.arkeProductId}`);

      // 3. Aggiorna in Arke con piano e materiali dal master
      await arkeRequest(`/product/product/${variant.arkeProductId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: existingProduct.name,
          internal_id: existingProduct.internal_id,
          type: existingProduct.type,
          uom: existingProduct.uom,
          categories: existingProduct.categories,
          prices: existingProduct.prices,
          attributes: existingProduct.attributes || {},
          description: existingProduct.description || '',
          version: existingProduct.version,
          plan: masterProduct.plan || [],               // DAL MASTER
          raw_materials: masterProduct.rawMaterials || [],  // DAL MASTER
        }),
      });

      // 4. Aggiorna status locale
      await storage.updateGeneratedVariantSyncStatus(variant.id, 'synced');
      results.push({ variantId: variant.id, success: true });
    } catch (error) {
      await storage.updateGeneratedVariantSyncStatus(variant.id, 'failed');
      results.push({ variantId: variant.id, success: false, error: error.message });
    }
  }

  res.json({
    success: results.every(r => r.success),
    results,
    totalSynced: results.filter(r => r.success).length,
    totalFailed: results.filter(r => !r.success).length,
  });
});
```

---

### 5.7 Import/Export Dati

#### POST /api/configurator/import-data
Importa dati del configuratore (gruppi, master, varianti) con deduplicazione.

**Request:**
```json
{
  "product_groups": [
    { "id": "uuid", "code": "CASH-FW25", "name": "...", "yarn": "...", "colors": [...] }
  ],
  "master_products": [
    { "id": "uuid", "arkeProductId": "...", "styleCode": "...", "...": "..." }
  ],
  "generated_variants": [
    { "id": "uuid", "masterProductId": "...", "colorCode": "...", "size": "...", "...": "..." }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "imported": { "groups": 2, "products": 5, "variants": 30 }
}
```

---

### 5.8 Endpoint Arke di Supporto

#### GET /api/arke/production-phases
Lista le fasi di produzione disponibili in Arke (usate nel piano lavorazioni).

**Response:**
```json
[
  {
    "id": "phase-uuid-1",
    "name": "Tessitura",
    "description": "Fase di tessitura su macchina rettilinea"
  },
  {
    "id": "phase-uuid-2",
    "name": "Cucito/Confezione",
    "description": "Cucito e assemblaggio capi"
  }
]
```

#### GET /api/arke/raw-materials
Lista materiali grezzi disponibili (usati come materie prime nelle fasi).

**Response:**
```json
{
  "items": [
    {
      "id": "mat-uuid",
      "name": "Cashmere Nm 28",
      "external_id": "CASH-001",
      "uom": "kilogram",
      "supplier_id": "supplier-uuid"
    }
  ],
  "hasMore": false,
  "nextOffset": 0
}
```

---

## 6. Flusso Frontend Completo

### 6.1 Pagina Configuratore (lista)

```
/catalogo/configuratore

┌─────────────────────────────────────────────────────┐
│  Configuratore Prodotti                              │
│                                                      │
│  [Tab: Prodotti Mastro]  [Tab: Gruppi]              │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ FW25-001 │  │ FW25-002 │  │ FW25-003 │          │
│  │ Pullover │  │ Cardigan │  │ Gilet    │          │
│  │ €185.00  │  │ €245.00  │  │ €165.00  │          │
│  │ 5 taglie │  │ 4 taglie │  │ 3 taglie │          │
│  │ 15 var.  │  │ 8 var.   │  │ 6 var.   │          │
│  │ [Click→] │  │ [Click→] │  │ [Click→] │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  [+ Nuovo Prodotto Mastro]                           │
└─────────────────────────────────────────────────────┘
```

**Query React:**
```tsx
const { data: masterProducts = [], isLoading } = useQuery<MasterProduct[]>({
  queryKey: ['/api/configurator/master-products'],
});

const { data: groups = [] } = useQuery<ProductGroup[]>({
  queryKey: ['/api/configurator/groups'],
});
```

### 6.2 Creazione Nuovo Master Product

Dialog modale con i campi:
- **Codice Stile** (styleCode) - univoco, es. "FW25-PULL-001"
- **Nome Stile** (styleName) - es. "Pullover Girocollo Cashmere"
- **Tipo Prodotto** (productType) - es. "pullover", "cardigan", "gilet"
- **Gruppo** (groupId) - dropdown, opzionale
- **Prezzo Base** (basePrice) - numerico, es. "185.00"
- **Valuta** (currency) - default "EUR"
- **Taglie** (sizes) - input con virgole, es. "XS, S, M, L, XL"
- **Descrizione** (description) - textarea opzionale

```tsx
const createMutation = useMutation({
  mutationFn: async (data: InsertMasterProduct) => {
    const res = await apiRequest('POST', '/api/configurator/master-products', data);
    return res.json();
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['/api/configurator/master-products'] });
    toast({ title: 'Prodotto mastro creato' });
  },
});
```

### 6.3 Dettaglio Master Product (4 tabs)

```
/catalogo/configuratore/:id

┌─────────────────────────────────────────────────────────────────┐
│  ← Torna al Configuratore                                       │
│                                                                  │
│  FW25-PULL-001 · Pullover Girocollo Cashmere                    │
│                                                                  │
│  [Panoramica] [Lavorazioni] [Varianti (15)] [Scheda Tecnica]   │
│  ─────────────────────────────────────────────────────────────   │
│                                                                  │
│  ... contenuto tab attivo ...                                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Query principale:**
```tsx
interface MasterWithArke extends MasterProduct {
  arkeProduct?: {
    version: number;
    plan: any[];
    raw_materials: any[];
    [key: string]: any;
  };
}

const { data: masterWithArke, isLoading } = useQuery<MasterWithArke>({
  queryKey: ['/api/configurator/master-products', masterId, 'arke-details'],
  enabled: !!masterId,
});

const { data: variants = [] } = useQuery<GeneratedVariant[]>({
  queryKey: ['/api/configurator/master-products', masterId, 'variants'],
  enabled: !!masterId,
});
```

---

### 6.4 Tab Panoramica

Mostra informazioni generali del prodotto:
- Codice stile e nome
- Tipo prodotto
- Prezzo base con valuta
- Gruppo di appartenenza
- Taglie configurate
- Numero varianti generate
- Stato sincronizzazione

### 6.5 Tab Lavorazioni

Gestione del piano di produzione con fasi e materiali.

```
┌─────────────────────────────────────────────────────────────┐
│  Fasi di Lavorazione                                         │
│  Configura le fasi di produzione e i materiali associati     │
│                                                              │
│  [+ Aggiungi Fase]  [Salva Piano]                           │
│                                                              │
│  ┌─ Fase 1: Tessitura ─────────────────────────────────┐   │
│  │  Descrizione: Tessitura corpo e maniche              │   │
│  │  Durata: 2 ore                                       │   │
│  │                                                       │   │
│  │  Materiali:                                           │   │
│  │  ┌─────────────────┬──────┬───────────┬─────────┐   │   │
│  │  │ Nome            │ Qtà  │ UoM       │ Azioni  │   │   │
│  │  ├─────────────────┼──────┼───────────┼─────────┤   │   │
│  │  │ Cashmere Nm 28  │ 0.35 │ kilogram  │ [×]     │   │   │
│  │  └─────────────────┴──────┴───────────┴─────────┘   │   │
│  │  [+ Aggiungi Materiale]                               │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Fase 2: Cucito/Confezione ──────────────────────────┐   │
│  │  ...                                                  │   │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Dati necessari dal backend:**
```tsx
// Fasi disponibili da Arke
const { data: productionPhases = [] } = useQuery({
  queryKey: ['/api/arke/production-phases'],
});

// Materiali disponibili da Arke
const { data: rawMaterialsData } = useQuery({
  queryKey: ['/api/arke/raw-materials'],
});
const rawMaterials = rawMaterialsData?.items || [];
```

**Salvataggio piano:**
```tsx
const savePlanMutation = useMutation({
  mutationFn: async (plan: any[]) => {
    const res = await apiRequest('PUT', `/api/configurator/master-products/${masterId}/plan`, { plan });
    return res.json();
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['/api/configurator/master-products', masterId] });
    toast({ title: 'Piano lavorazioni salvato' });
  },
});
```

### 6.6 Tab Varianti

Generazione e sincronizzazione varianti colore/taglia.

```
┌─────────────────────────────────────────────────────────────┐
│  Varianti Generate                                           │
│  Varianti colore/taglia create in Arke per questo mastro     │
│                                                              │
│  [+ Genera Varianti]  [🔄 Sincronizza (3 da aggiornare)]   │
│                                                              │
│  ┌──────────┬────────┬──────────────────────────┬────────┐  │
│  │ Colore   │ Taglia │ ID Arke                  │ Status │  │
│  ├──────────┼────────┼──────────────────────────┼────────┤  │
│  │ Bianco   │ S      │ FW25-PULL-001-Bianco-S   │ ✓ sync │  │
│  │ Bianco   │ M      │ FW25-PULL-001-Bianco-M   │ ⚠ upd  │  │
│  │ Bianco   │ L      │ FW25-PULL-001-Bianco-L   │ ✓ sync │  │
│  │ Nero     │ S      │ FW25-PULL-001-Nero-S     │ ✓ sync │  │
│  │ ...      │ ...    │ ...                      │ ...    │  │
│  └──────────┴────────┴──────────────────────────┴────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Dialog Genera Varianti:**

L'utente seleziona colori e taglie da una griglia. Il sistema mostra badge per combinazioni già esistenti e disabilita colori/taglie completamente coperti.

```tsx
// Calcolo combinazioni esistenti per la UI
const existingCombinations = new Set(variants.map(v => `${v.colorCode}-${v.size}`));

// Badge contatori per colori e taglie
const colorCounts = colors.reduce((acc, color) => {
  acc[color] = sizes.filter(size => existingCombinations.has(`${color}-${size}`)).length;
  return acc;
}, {});

const sizeCounts = sizes.reduce((acc, size) => {
  acc[size] = colors.filter(color => existingCombinations.has(`${color}-${size}`)).length;
  return acc;
}, {});

// Disabilita se completamente coperto
const isColorFullyCovered = (color) => colorCounts[color] === sizes.length;
const isSizeFullyCovered = (size) => sizeCounts[size] === colors.length;

// Mutazione generazione
const generateMutation = useMutation({
  mutationFn: async (data: { masterProductId: string; colors: string[]; sizes: string[] }) => {
    const res = await apiRequest('POST', '/api/configurator/generate-variants', data);
    return res.json();
  },
  onSuccess: (data) => {
    queryClient.invalidateQueries({ queryKey: ['/api/configurator/master-products', masterId, 'variants'] });
    toast({
      title: 'Varianti generate',
      description: `${data.totalGenerated} create, ${data.totalSkipped} saltate, ${data.totalFailed} fallite`,
    });
  },
});
```

**Sincronizzazione:**

Il pulsante "Sincronizza" appare solo quando ci sono varianti con `syncStatus !== 'synced'`.

```tsx
const needsSyncCount = variants.filter(v => v.syncStatus !== 'synced').length;

const syncMutation = useMutation({
  mutationFn: async () => {
    const res = await apiRequest('POST', '/api/configurator/sync-variants', { masterProductId: masterId });
    return res.json();
  },
  onSuccess: (data) => {
    queryClient.invalidateQueries({ queryKey: ['/api/configurator/master-products', masterId, 'variants'] });
    toast({
      title: 'Sincronizzazione completata',
      description: `${data.totalSynced} sincronizzate, ${data.totalFailed} fallite`,
    });
  },
});
```

### 6.7 Tab Scheda Tecnica

Layout in due sezioni principali:

**Sezione superiore:** Dettagli tecnici e immagine prodotto

```
┌─────────────────────────────────────────────────────────────────┐
│  Scheda Tecnica                                                  │
│  [Esporta PDF]  [Salva Scheda]                                  │
│                                                                  │
│  ┌── Riga 1: 3 colonne ────────────────────────────────────┐   │
│  │  [Filato: ___________]  [Composizione: ___]  [Finezza: _]│   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌── Riga 2: textarea ─────────────────────────────────────┐   │
│  │  [Descrizione/Lavorazione: ___________________________ ] │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌── Layout 2 colonne ─────────────────────────────────────┐   │
│  │                            │                             │   │
│  │  ┌─Tabella campi──────┐   │   ┌─Immagine────────────┐  │   │
│  │  │ Fondo    │ [_____ ]│   │   │                      │  │   │
│  │  │ Polsi    │ [_____ ]│   │   │    📷 Immagine      │  │   │
│  │  │ Collo    │ [_____ ]│   │   │    prodotto          │  │   │
│  │  │ Scollo   │ [_____ ]│   │   │                      │  │   │
│  │  │ Finta    │ [_____ ]│   │   │  [Carica Immagine]   │  │   │
│  │  │ Tasche   │ [_____ ]│   │   └──────────────────────┘  │   │
│  │  │ Bottoni  │ [_____ ]│   │                             │   │
│  │  └──────────┴─────────┘   │                             │   │
│  └───────────────────────────┴─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Sezione inferiore:** Tabella misure e note (2 card affiancate)

```
┌─────────────────────────────────┐  ┌──────────────────────────┐
│  📏 Tabella Misure               │  │  📝 Note                  │
│  [Nome misura: ____] [+]        │  │                           │
│                                  │  │  Istruzioni Lavaggio:    │
│  ┌──────────┬────┬────┬────┐   │  │  [__________________ ]   │
│  │ Misura   │ XS │ S  │ M  │   │  │                           │
│  ├──────────┼────┼────┼────┤   │  │  Note Varie:             │
│  │ Lungh.   │ 62 │ 64 │ 66 │   │  │  [__________________ ]   │
│  │ Spalle   │ 40 │ 42 │ 44 │   │  │  [__________________ ]   │
│  │ Manica   │ 58 │ 60 │ 62 │   │  │                           │
│  └──────────┴────┴────┴────┘   │  └──────────────────────────┘
└─────────────────────────────────┘
```

**Campi Scheda Tecnica (technicalDetails):**

| Campo | Tipo | Descrizione | Esempio |
|-------|------|-------------|---------|
| filato | string | Tipo di filato | "Cashmere 100%" |
| composizione | string | Composizione fibra | "80% Lana 20% Cashmere" |
| finezza | string | Finezza macchina | "GG 12" |
| lavorazione | string | Descrizione lavorazione | "Pullover girocollo..." |
| pesoMedio | string | Peso medio capo | "280g" |
| fondo | string | Tipo punto fondo | "Jersey" |
| polsi | string | Lavorazione polsi | "Costa 2x2 h.7cm" |
| collo | string | Tipo collo | "Girocollo costa 2x2" |
| scollo | string | Tipo scollo | "Girocollo" |
| finta | string | Finta/allacciatura | "Con zip nascosta" |
| tasche | string | Descrizione tasche | "2 tasche frontali" |
| bottoni | string | Tipo/numero bottoni | "6 bottoni madreperla" |
| lavaggio | string | Istruzioni lavaggio | "Lavaggio a mano 30°C" |
| noteVarie | string | Note aggiuntive | "Peso medio: 280g taglia M" |

**Tabella Misure (measurements):**

Struttura: `{ rows: [{ name: string, values: { [taglia]: string } }] }`

Le colonne sono dinamiche e corrispondono alle taglie del master product (`sizes` array).

**Gestione stato locale:**
```tsx
const [technicalDetails, setTechnicalDetails] = useState<TechnicalDetails>({});
const [measurements, setMeasurements] = useState<Measurements>({ rows: [] });
const [imageUrl, setImageUrl] = useState<string>('');
const [isTechnicalDirty, setIsTechnicalDirty] = useState(false);

// Inizializzazione da dati caricati
useEffect(() => {
  if (masterWithArke) {
    setTechnicalDetails(masterWithArke.technicalDetails as TechnicalDetails || {});
    setMeasurements(masterWithArke.measurements as Measurements || { rows: [] });
    setImageUrl(masterWithArke.imageUrl || '');
    setIsTechnicalDirty(false);
  }
}, [masterWithArke]);

// Handler generico per campi tecnici
const handleTechnicalDetailChange = (field: keyof TechnicalDetails, value: string) => {
  setTechnicalDetails(prev => ({ ...prev, [field]: value }));
  setIsTechnicalDirty(true);
};

// Handler misure
const handleAddMeasurementRow = () => {
  if (!newMeasurementName.trim()) return;
  setMeasurements(prev => ({
    rows: [...(prev?.rows || []), { name: newMeasurementName.trim(), values: {} }]
  }));
  setNewMeasurementName('');
  setIsTechnicalDirty(true);
};

const handleRemoveMeasurementRow = (index: number) => {
  setMeasurements(prev => ({
    rows: (prev?.rows || []).filter((_, i) => i !== index)
  }));
  setIsTechnicalDirty(true);
};

const handleMeasurementChange = (rowIndex: number, size: string, value: string) => {
  setMeasurements(prev => ({
    rows: (prev?.rows || []).map((row, i) => 
      i === rowIndex ? { ...row, values: { ...row.values, [size]: value } } : row
    )
  }));
  setIsTechnicalDirty(true);
};

// Salvataggio
const handleSaveTechnicalSheet = () => {
  saveTechnicalSheetMutation.mutate({
    imageUrl,
    technicalDetails,
    measurements,
  });
};

// Mutazione
const saveTechnicalSheetMutation = useMutation({
  mutationFn: async (data: { imageUrl?: string; technicalDetails?: TechnicalDetails; measurements?: Measurements }) => {
    const res = await apiRequest('PUT', `/api/configurator/master-products/${masterId}/technical-sheet`, data);
    return res.json();
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['/api/configurator/master-products', masterId] });
    setIsTechnicalDirty(false);
    toast({ title: 'Scheda tecnica salvata' });
  },
});
```

### 6.8 Upload Immagine (Object Storage)

L'immagine del prodotto viene caricata su Object Storage tramite URL firmati.

```tsx
// 1. Richiedi URL di upload
const res = await fetch("/api/uploads/request-url", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: file.name,
    size: file.size,
    contentType: file.type,
  }),
});

const { uploadURL, objectPath } = await res.json();

// 2. Carica file direttamente su Object Storage
await fetch(uploadURL, {
  method: "PUT",
  headers: { "Content-Type": file.type },
  body: file,
});

// 3. Salva il path nell'imageUrl del master product
handleImageUploaded(objectPath);
```

### 6.9 Export PDF Scheda Tecnica

```tsx
const handleExportPDF = () => {
  // Logica per generare PDF con:
  // - Header: codice stile, nome, tipo
  // - Sezione: dettagli tecnici (tutti i campi)
  // - Sezione: immagine prodotto
  // - Tabella: misure per taglia
  // - Footer: note e istruzioni lavaggio
};
```

---

## 7. Flusso di Sincronizzazione

### Quando viene triggerata

```
Master Product aggiornato (PUT /api/configurator/master-products/:id)
        │
        ▼
  markVariantsForSync(masterProductId)
  → Tutte le varianti: syncStatus = "needs_update"
        │
        ▼
  Frontend mostra badge "X varianti da aggiornare"
  e pulsante "Sincronizza"
        │
        ▼
  Utente clicca "Sincronizza"
        │
        ▼
  POST /api/configurator/sync-variants
        │
        ▼
  Per ogni variante needs_update/failed:
  ├── Recupera prodotto Arke corrente (GET)
  ├── Aggiorna con plan + rawMaterials dal master (PUT)
  ├── Successo → syncStatus = "synced"
  └── Fallimento → syncStatus = "failed"
```

### Piano lavorazioni aggiornato

```
PUT /api/configurator/master-products/:id/plan
        │
        ├── 1. Recupera prodotto Arke (GET) → version
        ├── 2. Aggiorna Arke con nuovo plan (PUT con tutti i campi)
        ├── 3. Aggiorna plan localmente
        └── 4. markVariantsForSync() → tutte le varianti "needs_update"
```

---

## 8. Routing Frontend

```typescript
import { Switch, Route } from "wouter";

<Switch>
  <Route path="/catalogo/configuratore" component={ConfiguratorPage} />
  <Route path="/catalogo/configuratore/:id" component={MasterProductDetailPage} />
  <Route path="/catalogo/prodotti" component={ProductsListPage} />
</Switch>
```

---

## 9. Cache Invalidation (TanStack Query)

```typescript
// Dopo creazione/modifica master product
queryClient.invalidateQueries({ queryKey: ['/api/configurator/master-products'] });

// Dopo modifica specifico master
queryClient.invalidateQueries({ queryKey: ['/api/configurator/master-products', masterId] });

// Dopo generazione/sync varianti
queryClient.invalidateQueries({ queryKey: ['/api/configurator/master-products', masterId, 'variants'] });

// Dopo modifica gruppi
queryClient.invalidateQueries({ queryKey: ['/api/configurator/groups'] });
```

---

## 10. Variabili Ambiente

```env
# Database PostgreSQL
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Arke ERP API
ARKE_BASE_URL=https://your-arke-instance.com/api
ARKE_TOKEN=your-bearer-token

# Session
SESSION_SECRET=your-session-secret

# Object Storage (per upload immagini)
DEFAULT_OBJECT_STORAGE_BUCKET_ID=bucket-id
PUBLIC_OBJECT_SEARCH_PATHS=public
PRIVATE_OBJECT_DIR=.private
```

---

## 11. Dipendenze NPM

```json
{
  "dependencies": {
    "express": "^5.x",
    "express-session": "^1.x",
    "drizzle-orm": "^0.x",
    "drizzle-zod": "^0.x",
    "@neondatabase/serverless": "^0.x",
    "zod": "^3.x",
    "@tanstack/react-query": "^5.x",
    "wouter": "^3.x",
    "react-hook-form": "^7.x",
    "@hookform/resolvers": "^3.x"
  }
}
```

---

## 12. Note Importanti

1. **Arke PUT richiede TUTTI i campi**: Quando si aggiorna un prodotto in Arke, bisogna inviare TUTTI i campi obbligatori (name, internal_id, type, uom, categories, prices, attributes, description, version). Non è un PATCH.

2. **Concurrency Control**: Il campo `version` di Arke serve per evitare conflitti. Bisogna sempre recuperare la versione corrente prima di aggiornare.

3. **master_type**: Il campo `master_type` in Arke è uguale allo `styleCode` del master. Serve per raggruppare tutte le varianti sotto lo stesso master.

4. **Dual Storage**: I dati del configuratore vivono sia localmente (PostgreSQL) che in Arke. Il piano e i materiali devono essere sincronizzati in entrambi i posti.

5. **Sync Lazy**: Le varianti non vengono aggiornate automaticamente quando il master cambia. Vengono solo marcate come "needs_update" e l'utente decide quando sincronizzare.

6. **Skip Duplicati**: La generazione varianti controlla le combinazioni già esistenti e le salta automaticamente.

7. **Taglie Dinamiche**: Le colonne della tabella misure corrispondono all'array `sizes` del master product. Aggiungendo una taglia, si aggiunge automaticamente una colonna.

8. **Object Storage**: Le immagini prodotto vengono caricate su Object Storage (Replit) tramite URL firmati, non sul filesystem locale.

---

## Autore

Documentazione generata per Highline Gestionale Maglificio.
Versione: 1.0
Data: Febbraio 2026
