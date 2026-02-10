# Arke Assistant - Gestionale Filati

## Overview

Arke Assistant is an ERP-style web application for the Arke system, specialized in managing yarns and textile products (HATFIL). It provides both AI-powered chat assistants and direct data views for products, orders, inventory, and contacts. The system integrates with external Arke API microservices (product-api, sales-api, supply-api, iam-api) and leverages AI models (OpenAI and Anthropic) for conversational features.

### Navigation Structure (Top NavBar - no sidebar)
- **Home** (/) - AI assistants and tools dashboard
- **Vendite** (/vendite) - Sales orders table with search and status filters
- **Catalogo** (dropdown):
  - Configuratore (/catalogo/configuratore) - Product variant generator
  - Articoli (/catalogo/articoli) - Products catalog table
- **Magazzino** (dropdown):
  - Inventario (/magazzino/inventario) - Inventory items with bucket quantities, PDF print with master filter
  - Valore Inventario (/magazzino/valore-inventario) - Inventory value grouped by master product family
  - DDT in Ingresso (/magazzino/ddt-inbound) - PDF extraction for inbound DDTs
  - Evasione Rapida (/magazzino/evasione-rapida) - Turkey order fulfillment
- **Contatti** (/contatti) - Customers and suppliers with tabs

### Backend Proxy Routes
- `/api/sales/orders` - Sales orders list/detail
- `/api/products` - Products list/detail
- `/api/inventory` - Inventory items
- `/api/inventory/value` - Inventory value grouped by master product (crosses inventory qty with product prices)
- `/api/inventory/warehouse-stock/pdf` - PDF report of warehouse stock with optional `?masters=` filter
- `/api/customers` - Customers list/detail
- `/api/suppliers` - Suppliers list/detail
All routes proxy to Arke backend using arkeService with session-based auth tokens.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Core Principles
The AI interprets user intent, but actions on Arke are deterministic via function calling. This involves a clear separation of responsibilities: the AI (LLM) understands user intent and extracts entities, while `arkeService` constructs 100% valid API payloads.

### Frontend
- **Framework**: React with TypeScript (Vite)
- **Routing**: Wouter
- **State Management**: TanStack React Query
- **UI Components**: shadcn/ui (Radix UI)
- **Styling**: Tailwind CSS with CSS variables (light/dark mode)

### Backend
- **Framework**: Express.js with TypeScript
- **API Pattern**: RESTful endpoints (`/api/`)
- **AI Integration**: Dual AI provider support (OpenAI, Anthropic) via Replit AI Integrations
- **Streaming**: Server-Sent Events (SSE) for real-time AI responses

### Authentication
- **Session Management**: Express-session with memorystore
- **Token Handling**: JWT tokens from Arke API stored in server-side sessions
- **Security**: HTTP-only cookies, SameSite protection, session regeneration on login, 24-hour expiry.

### Data Storage
- **Database**: PostgreSQL with Drizzle ORM
- **Schema**: `shared/schema.ts`
- **Tables**: `users`, `agents`, `conversations`, `messages`, `order_drafts`.

### Multi-Agent System
- **Agent Focus**: Primarily a "Crea Ordine Vendita" (Sales Order Creation) agent.
- **Tools**: Includes `search_customer`, `search_product`, `draft_set_customer`, `draft_add_item`, `draft_show_summary`, `clear_session`, `submit_order`.
- **Workflow**: Guides users through order creation step-by-step, persisting draft state in PostgreSQL.

### Key Design Patterns
- **Shared Types**: `shared/` directory for common schemas and types.
- **Path Aliases**: `@/` for client, `@shared/` for shared code.
- **Replit Integrations**: Modular patterns in `server/replit_integrations/`.

### Build System
- **Development**: `tsx` with hot reload.
- **Production**: esbuild for server, Vite for client.

### Product Configurator
Allows generating product variants by combining master products with color codes.
- **Functionality**: Imports catalog data, lists color folders/master products, checks for duplicates, generates products on Arke, and manages custom colors for specific customers.
- **Data**: Uses `colorFolders`, `colors`, `masterProducts`, `generatedProducts`, `customColors` tables.

### DDT Inbound - AI Extractor
Tool for AI-powered data extraction from HATFIL PDF invoices to create inbound DDTs in Arke.
- **Workflow**: Upload PDF, AI extracts data (invoice number, date, products, lot, weight, price), converts product names to Arke format, matches with existing catalog, allows user review, and confirms DDT creation.
- **Logic**: Handles existing and new products, associating them with suppliers.

### Quick Order Fulfillment (Turkey Fulfillment)
Tool for rapidly fulfilling sales orders shipped from Turkey.
- **Workflow**: Select an active sales order and warehouse, verify details, then the system adjusts inventory and creates a pre-filled sales DDT in draft status.

## External Dependencies

### External APIs
- **Arke API**: Main ERP system integration via `ARKE_BASE_URL` and `ARKE_API_TOKEN`. Provides comprehensive access to product, sales, supply, and IAM data. Supports CRUD operations for products, customers, sales orders, supply orders, suppliers, raw materials, warehouses, inventory, production, and transport documents.

### AI Services (via Replit AI Integrations)
- **OpenAI**: Used for chat completions, speech-to-text, text-to-speech, and image generation.
- **Anthropic**: Alternative AI provider for chat completions.

### Database
- **PostgreSQL**: Primary data store, accessed via `DATABASE_URL`. Utilizes `drizzle-orm` and `connect-pg-simple` for session storage.