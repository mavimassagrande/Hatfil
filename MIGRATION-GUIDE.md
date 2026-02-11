# Guida Migrazione: Replit → GCP Cloud Run + AlloyDB

Documento basato sulla migrazione dell'app **Hatfil** (febbraio 2026). Contiene tutti i passaggi, configurazioni e lezioni apprese, riutilizzabile per migrazioni future.

---

## Indice

1. [Overview Architettura](#1-overview-architettura)
2. [Prerequisiti e API da abilitare](#2-prerequisiti-e-api-da-abilitare)
3. [Modifiche al codice dell'app](#3-modifiche-al-codice-dellapp)
4. [Dockerfile](#4-dockerfile)
5. [VPC e Networking](#5-vpc-e-networking)
6. [AlloyDB (PostgreSQL)](#6-alloydb-postgresql)
7. [Secret Manager](#7-secret-manager)
8. [Artifact Registry](#8-artifact-registry)
9. [Cloud Run](#9-cloud-run)
10. [CI/CD con GitHub Actions](#10-cicd-con-github-actions)
11. [Deploy manuale con Cloud Build](#11-deploy-manuale-con-cloud-build)
12. [Dominio personalizzato](#12-dominio-personalizzato)
13. [Import dati nel database](#13-import-dati-nel-database)
14. [Troubleshooting e lezioni apprese](#14-troubleshooting-e-lezioni-apprese)
15. [Costi](#15-costi)
16. [Checklist rapida](#16-checklist-rapida)

---

## 1. Overview Architettura

```
Internet (HTTPS)
    ↓
Dominio personalizzato (CNAME → ghs.googlehosted.com)
    ↓
Cloud Run (europe-west1) — container Node.js, porta 8080
    ↓
VPC Connector (europe-west1, 10.8.0.0/28)
    ↓
Default VPC → Private Services Access (VPC peering, 10.100.0.0/16)
    ↓
AlloyDB (europe-west1, IP privato 10.100.0.2, PostgreSQL 17)
```

**Principi chiave:**
- Tutto nella **stessa regione** (europe-west1)
- Tutto nella **stessa VPC** (default)
- Database raggiungibile solo via **IP privato** (no public IP)
- Secrets in **Secret Manager** (mai nel codice o nelle env vars del container)
- CI/CD via **GitHub Actions** (build Docker → push Artifact Registry → deploy Cloud Run)

---

## 2. Prerequisiti e API da abilitare

### Progetto GCP
```bash
export PROJECT_ID="arkeplatform"
export REGION="europe-west1"
gcloud config set project $PROJECT_ID
```

### API necessarie
```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  vpcaccess.googleapis.com \
  compute.googleapis.com \
  alloydb.googleapis.com \
  servicenetworking.googleapis.com
```

### Service Accounts necessari

| Service Account | Ruoli | Uso |
|-----------------|-------|-----|
| `{PROJECT_NUMBER}-compute@developer.gserviceaccount.com` | Default compute SA | Cloud Build, Cloud Run runtime |
| `github-actions@{PROJECT_ID}.iam.gserviceaccount.com` | Creato manualmente | CI/CD da GitHub Actions |

**Ruoli per il SA GitHub Actions:**
```bash
SA_EMAIL="github-actions@${PROJECT_ID}.iam.gserviceaccount.com"

# Creare il SA
gcloud iam service-accounts create github-actions \
  --display-name="GitHub Actions Deployer" \
  --project=$PROJECT_ID

# Assegnare ruoli
for ROLE in roles/artifactregistry.writer roles/run.admin roles/iam.serviceAccountUser roles/storage.admin; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$ROLE"
done
```

**Ruolo per il default compute SA (accesso ai secrets):**
```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for SECRET in DATABASE_URL ARKE_API_TOKEN OPENAI_API_KEY ANTHROPIC_API_KEY SESSION_SECRET; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project=$PROJECT_ID
done
```

---

## 3. Modifiche al codice dell'app

### Modifiche obbligatorie per Cloud Run

**`server/index.ts`** — Due cambiamenti critici:

```typescript
// PRIMA (Replit)
const port = parseInt(process.env.PORT || "5000", 10);
httpServer.listen({ port, host: "127.0.0.1" }, () => { ... });

// DOPO (Cloud Run)
const port = parseInt(process.env.PORT || "8080", 10);
httpServer.listen({ port, host: "0.0.0.0" }, () => { ... });
```

**Perché:**
- Cloud Run inietta `PORT=8080` (ma il default deve essere 8080, non 5000)
- Cloud Run richiede binding su `0.0.0.0` (non `127.0.0.1`) altrimenti il container non accetta traffico e va in crash loop

### Endpoint health check

Cloud Run ha bisogno di un health check. Aggiungere in `server/routes.ts`:
```typescript
app.get("/api/health", (_req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString(), service: "hatfil-api" });
});
```

### `.gitignore` — aggiungere:
```
sa-key.json
*.pem
test-alloydb-connection.js
.env
.env.local
.env.*.local
```

---

## 4. Dockerfile

Multi-stage build per minimizzare la dimensione dell'immagine:

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY script ./script
COPY attached_assets ./attached_assets
COPY vite.config.ts tailwind.config.ts postcss.config.js drizzle.config.ts ./
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY server/seed-data ./server/seed-data

# Security: non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app
USER nodejs

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/index.cjs"]
```

### `.dockerignore`
```
node_modules
dist
.git
.env
.env.*
*.md
.replit
.DS_Store
npm-debug.log
*.test.ts
*.test.tsx
coverage
.vscode
.idea
```

---

## 5. VPC e Networking

### 5.1 Private Services Access (per AlloyDB)

AlloyDB con VPC networking richiede un peering tra la VPC e la rete Google.

```bash
# 1. Allocare un range IP dedicato
gcloud compute addresses create google-managed-services-default \
  --global \
  --purpose=VPC_PEERING \
  --addresses=10.100.0.0 \
  --prefix-length=16 \
  --network=default \
  --project=$PROJECT_ID

# 2. Creare la connessione VPC peering
gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-default \
  --network=default \
  --project=$PROJECT_ID
```

**Configurazione risultante:**
| Parametro | Valore |
|-----------|--------|
| Nome | `google-managed-services-default` |
| Range IP | `10.100.0.0/16` |
| Network | `default` |
| Purpose | `VPC_PEERING` |

### 5.2 VPC Connector (per Cloud Run)

Cloud Run è serverless e non vive nella VPC. Per raggiungere le risorse private (AlloyDB) serve un VPC Connector.

```bash
gcloud compute networks vpc-access connectors create hatfil-vpc-connector \
  --region=$REGION \
  --network=default \
  --range=10.8.0.0/28 \
  --min-instances=2 \
  --max-instances=3 \
  --machine-type=e2-micro \
  --project=$PROJECT_ID
```

**Configurazione risultante:**
| Parametro | Valore |
|-----------|--------|
| Nome | `hatfil-vpc-connector` |
| Regione | `europe-west1` |
| Network | `default` |
| IP Range | `10.8.0.0/28` |
| Machine type | `e2-micro` |
| Min/Max instances | `2` / `3` |
| VPC egress | `private-ranges-only` |

**ATTENZIONE:** Il VPC connector **deve essere nella stessa regione** di Cloud Run.

---

## 6. AlloyDB (PostgreSQL)

### 6.1 Scelta: VPC Networking vs PSC

AlloyDB supporta due modalità di rete:
- **VPC Networking** (consigliato): IP privato nella VPC, raggiungibile tramite VPC Connector
- **PSC (Private Service Connect)**: richiede un endpoint PSC per risolvere l'hostname — più complesso e non necessario per Cloud Run nella stessa VPC

**Usare sempre VPC Networking per Cloud Run + AlloyDB nella stessa regione.**

### 6.2 Creazione cluster

```bash
gcloud alloydb clusters create hatfil-db \
  --region=$REGION \
  --network=default \
  --allocated-ip-range-name=google-managed-services-default \
  --database-version=POSTGRES_17 \
  --password="STRONG_PASSWORD_HERE" \
  --project=$PROJECT_ID
```

**NOTA:** `--password` è **obbligatorio** alla creazione del cluster (imposta la password dell'utente `postgres`).

### 6.3 Creazione istanza primaria

```bash
gcloud alloydb instances create primary \
  --cluster=hatfil-db \
  --region=$REGION \
  --instance-type=PRIMARY \
  --cpu-count=2 \
  --project=$PROJECT_ID
```

**Configurazione risultante:**
| Parametro | Valore |
|-----------|--------|
| Cluster | `hatfil-db` |
| Instance | `primary` |
| Regione | `europe-west1` |
| Database version | `POSTGRES_17` |
| CPU | 2 vCPU (minimo AlloyDB) |
| Machine type | `n2-highmem-2` (implicito) |
| IP privato | `10.100.0.2` |
| SSL mode | `ENCRYPTED_ONLY` |
| Availability | `REGIONAL` |
| Backup continuo | abilitato, 14 giorni retention |

### 6.4 Connection string

```
postgresql://postgres:PASSWORD@10.100.0.2:5432/postgres
```

**NOTA SSL:** AlloyDB con VPC networking usa `sslMode: ENCRYPTED_ONLY` di default. La libreria `pg` di Node.js gestisce SSL automaticamente. Se ci sono problemi, aggiungere `?sslmode=require` alla connection string. NON usare `sslmode=disable`.

### 6.5 Cambio password

```bash
gcloud alloydb users set-password postgres \
  --cluster=hatfil-db \
  --region=$REGION \
  --password="NEW_PASSWORD" \
  --project=$PROJECT_ID
```

**LEZIONE APPRESA:** Evitare caratteri speciali come `!` nella password — causano problemi di shell escaping in vari contesti (script bash, psql, PGPASSWORD).

---

## 7. Secret Manager

### Secrets utilizzati

| Secret | Contenuto | Usato da |
|--------|-----------|----------|
| `DATABASE_URL` | `postgresql://postgres:xxx@10.100.0.2:5432/postgres` | Server (Drizzle ORM) |
| `ARKE_API_TOKEN` | Token API Arke ERP | Server (API calls) |
| `OPENAI_API_KEY` | API key OpenAI | Server (AI chat) |
| `ANTHROPIC_API_KEY` | API key Anthropic | Server (AI chat) |
| `SESSION_SECRET` | Random string per sessioni Express | Server (auth) |

### Creare un secret
```bash
echo -n "valore_del_secret" | \
  gcloud secrets create NOME_SECRET --data-file=- --project=$PROJECT_ID
```

### Aggiornare un secret (nuova versione)
```bash
echo -n "nuovo_valore" | \
  gcloud secrets versions add NOME_SECRET --data-file=- --project=$PROJECT_ID
```

### Come Cloud Run accede ai secrets

Nel deploy (`--set-secrets`), Cloud Run monta i secrets come variabili d'ambiente:
```
--set-secrets=DATABASE_URL=DATABASE_URL:latest,ARKE_API_TOKEN=ARKE_API_TOKEN:latest,...
```

Il default compute SA deve avere `roles/secretmanager.secretAccessor` su ogni secret.

---

## 8. Artifact Registry

Repository per le immagini Docker.

```bash
gcloud artifacts repositories create hatfil \
  --repository-format=docker \
  --location=$REGION \
  --description="Hatfil container images" \
  --project=$PROJECT_ID
```

**Naming convention immagini:**
```
europe-west1-docker.pkg.dev/arkeplatform/hatfil/hatfil-app:{tag}
```

Tags:
- `latest` — ultima build
- `{git-sha}` — immutabile, usato per il deploy (rollback facile)

---

## 9. Cloud Run

### Configurazione servizio

| Parametro | Valore | Note |
|-----------|--------|------|
| Nome | `hatfil-app` | |
| Regione | `europe-west1` | Stessa di AlloyDB e VPC Connector |
| CPU | 1 | |
| Memory | 512Mi | |
| Min instances | 1 | Evita cold start |
| Max instances | 10 | |
| Concurrency | 80 | Richieste per container |
| Timeout | 300s | |
| Port | 8080 | Quello del container |
| Ingress | all | Accesso pubblico |
| Auth | allow-unauthenticated | App web pubblica |
| VPC Connector | `hatfil-vpc-connector` | Per raggiungere AlloyDB |
| VPC egress | private-ranges-only | Solo traffico verso IP privati via VPC |
| Startup CPU boost | true | Accelera il cold start |

### Environment variables (non-secret)
```
NODE_ENV=production
ARKE_BASE_URL=https://hatfil.arke.so/api
NODE_TLS_REJECT_UNAUTHORIZED=0
```

### Deploy manuale
```bash
gcloud run deploy hatfil-app \
  --image=europe-west1-docker.pkg.dev/$PROJECT_ID/hatfil/hatfil-app:latest \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=10 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=300 \
  --concurrency=80 \
  --vpc-connector=hatfil-vpc-connector \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest,ARKE_API_TOKEN=ARKE_API_TOKEN:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,SESSION_SECRET=SESSION_SECRET:latest \
  --set-env-vars=NODE_ENV=production,ARKE_BASE_URL=https://hatfil.arke.so/api,NODE_TLS_REJECT_UNAUTHORIZED=0 \
  --project=$PROJECT_ID
```

### Rollback
```bash
# Lista revisioni
gcloud run revisions list --service=hatfil-app --region=$REGION --project=$PROJECT_ID

# Rollback a una revisione specifica
gcloud run services update-traffic hatfil-app \
  --region=$REGION \
  --to-revisions=hatfil-app-00012-ngp=100 \
  --project=$PROJECT_ID
```

### Logs
```bash
gcloud run services logs read hatfil-app \
  --project=$PROJECT_ID \
  --region=$REGION \
  --limit=50
```

---

## 10. CI/CD con GitHub Actions

### GitHub Secret richiesto

| Secret Name | Contenuto |
|-------------|-----------|
| `GCP_SA_KEY` | JSON della chiave del SA `github-actions@arkeplatform.iam.gserviceaccount.com` |

Per creare la chiave:
```bash
gcloud iam service-accounts keys create sa-key.json \
  --iam-account=github-actions@${PROJECT_ID}.iam.gserviceaccount.com

# Copiare il contenuto di sa-key.json come GitHub Secret GCP_SA_KEY
# POI ELIMINARE sa-key.json dal disco!
```

### Workflow `.github/workflows/deploy.yml`

```yaml
name: Deploy to Cloud Run

on:
  push:
    branches:
      - main
  workflow_dispatch:

env:
  PROJECT_ID: arkeplatform
  REGION: europe-west1
  SERVICE_NAME: hatfil-app
  IMAGE: europe-west1-docker.pkg.dev/arkeplatform/hatfil/hatfil-app

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet

      - name: Build Docker image
        run: docker build -t $IMAGE:${{ github.sha }} -t $IMAGE:latest .

      - name: Push Docker image
        run: |
          docker push $IMAGE:${{ github.sha }}
          docker push $IMAGE:latest

      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy $SERVICE_NAME \
            --image=$IMAGE:${{ github.sha }} \
            --region=$REGION \
            --platform=managed \
            --allow-unauthenticated \
            --min-instances=1 \
            --max-instances=10 \
            --memory=512Mi \
            --cpu=1 \
            --timeout=300 \
            --concurrency=80 \
            --vpc-connector=hatfil-vpc-connector \
            --set-secrets=DATABASE_URL=DATABASE_URL:latest \
            --set-env-vars=NODE_ENV=production \
            --project=$PROJECT_ID

      - name: Show Service URL
        run: |
          URL=$(gcloud run services describe $SERVICE_NAME \
            --region=$REGION --project=$PROJECT_ID \
            --format="value(status.url)")
          echo "Deployed to: $URL"
```

**NOTA:** NON usare `gcloud builds submit` da GitHub Actions — il SA non ha permessi per streamare i log di Cloud Build e il job fallisce. Fare build Docker direttamente nel runner GitHub.

### Deploy manuale con Cloud Build (dalla propria macchina)

Il file `cloudbuild.yaml` resta utile per deploy rapidi dalla macchina locale:

```bash
cd /path/to/project
gcloud builds submit --config=cloudbuild.yaml --project=$PROJECT_ID --region=$REGION
```

oppure:
```bash
./deploy.sh
```

---

## 11. Deploy manuale con Cloud Build

Il `cloudbuild.yaml` esegue tre step: build Docker → push Artifact Registry → deploy Cloud Run.

```yaml
steps:
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'europe-west1-docker.pkg.dev/$PROJECT_ID/hatfil/hatfil-app:latest', '.']
    timeout: 900s

  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', '--all-tags', 'europe-west1-docker.pkg.dev/$PROJECT_ID/hatfil/hatfil-app']

  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args:
      - 'run'
      - 'deploy'
      - 'hatfil-app'
      - '--image=europe-west1-docker.pkg.dev/$PROJECT_ID/hatfil/hatfil-app:latest'
      - '--region=europe-west1'
      - '--platform=managed'
      - '--allow-unauthenticated'
      - '--min-instances=1'
      - '--max-instances=10'
      - '--memory=512Mi'
      - '--cpu=1'
      - '--timeout=300'
      - '--concurrency=80'
      - '--vpc-connector=hatfil-vpc-connector'
      - '--set-secrets=DATABASE_URL=DATABASE_URL:latest,...'
      - '--set-env-vars=NODE_ENV=production,...'

images:
  - 'europe-west1-docker.pkg.dev/$PROJECT_ID/hatfil/hatfil-app:latest'
timeout: 1200s
options:
  machineType: 'E2_HIGHCPU_8'
```

---

## 12. Dominio personalizzato

```bash
# Mappare il dominio su Cloud Run
gcloud run domain-mappings create \
  --service=hatfil-app \
  --domain=test.hatfilarke.com \
  --region=$REGION \
  --project=$PROJECT_ID
```

Poi configurare il CNAME nel DNS:
```
test.hatfilarke.com  CNAME  ghs.googlehosted.com.
```

Cloud Run gestisce automaticamente il certificato SSL (Let's Encrypt).

---

## 13. Import dati nel database

AlloyDB è raggiungibile solo via IP privato. Per importare dati dalla macchina locale:

### Metodo: VM temporanea

```bash
# 1. Creare VM temporanea nella stessa VPC
gcloud compute instances create import-vm \
  --zone=europe-west1-b \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --project=$PROJECT_ID \
  --metadata=startup-script='#!/bin/bash
    apt-get update -qq && apt-get install -y -qq postgresql-client > /dev/null 2>&1
    touch /tmp/ready'

# 2. Aspettare che sia pronta e copiare il file SQL
sleep 30
gcloud compute scp import.sql import-vm:/tmp/ --zone=europe-west1-b --project=$PROJECT_ID

# 3. Eseguire l'import
gcloud compute ssh import-vm --zone=europe-west1-b --project=$PROJECT_ID --command="\
  while [ ! -f /tmp/ready ]; do sleep 2; done
  PGPASSWORD='PASSWORD' psql 'host=10.100.0.2 port=5432 user=postgres dbname=postgres sslmode=require' -f /tmp/import.sql"

# 4. Eliminare la VM
gcloud compute instances delete import-vm --zone=europe-west1-b --project=$PROJECT_ID --quiet
```

### Generare SQL da JSON

Se i dati provengono da export JSON (es. da Replit), usare uno script Python per generare INSERT statements. Punti chiave:

- Inserire in ordine di dipendenza FK (color_folders → colors → master_products, ecc.)
- Usare `SELECT setval('table_id_seq', max_id)` dopo ogni tabella per riallineare le sequenze seriali
- Escape delle single quote: `str.replace("'", "''")`
- Array PostgreSQL: `'{"val1","val2"}'::text[]`
- `sslmode=require` è necessario (AlloyDB usa `ENCRYPTED_ONLY`)

### Metodo alternativo: AlloyDB Auth Proxy

Richiede Application Default Credentials (ADC) configurate:
```bash
gcloud auth application-default login
alloydb-auth-proxy "projects/$PROJECT_ID/locations/$REGION/clusters/hatfil-db/instances/primary" --port=5433
# In un altro terminale:
psql "host=localhost port=5433 user=postgres dbname=postgres" -f import.sql
```

---

## 14. Troubleshooting e lezioni apprese

### `getaddrinfo ENOTFOUND` sull'hostname AlloyDB
**Causa:** AlloyDB creato con PSC (Private Service Connect) ma nessun endpoint PSC configurato nella VPC.
**Soluzione:** Ricreare AlloyDB con VPC Networking (non PSC). Assicurarsi che Private Services Access sia configurato.

### Cloud Run non raggiunge AlloyDB
**Checklist:**
1. Cloud Run e AlloyDB sono nella **stessa regione**?
2. Il **VPC Connector** è nella stessa regione di Cloud Run?
3. Il VPC Connector è sulla **stessa VPC** di AlloyDB?
4. **Private Services Access** è configurato sulla VPC?
5. La connection string usa l'**IP privato** (non l'hostname PSC)?

### `password authentication failed` con psql
**Causa:** Caratteri speciali (es. `!`) nella password vengono interpretati dalla shell.
**Soluzione:** Usare password senza caratteri speciali, oppure usare `PGPASSWORD` con single quotes.

### GitHub Actions fallisce su `gcloud builds submit`
**Causa:** Il SA non ha permessi per streamare i log di Cloud Build (`roles/viewer` o `roles/logging.viewer`).
**Soluzione:** Non usare Cloud Build da GitHub Actions. Fare build Docker direttamente nel runner GitHub e deploy con `gcloud run deploy`.

### Container Cloud Run in crash loop
**Causa comune:** Il server fa bind su `127.0.0.1` (localhost) invece di `0.0.0.0`.
**Soluzione:** Cambiare `host: "127.0.0.1"` in `host: "0.0.0.0"` e assicurarsi che la porta sia `8080`.

### Cold start lento
**Mitigazione:**
- `--min-instances=1` per avere sempre un container caldo
- Startup CPU boost (abilitato di default)
- Multi-stage Dockerfile per minimizzare la dimensione dell'immagine

---

## 15. Costi

Stima mensile (febbraio 2026, regione europe-west1):

| Risorsa | Configurazione | Costo/mese |
|---------|---------------|------------|
| AlloyDB | 2 vCPU (minimo), REGIONAL | ~$150 (trial gratuito i primi 60 giorni) |
| Cloud Run | 1 min instance, 512Mi, 1 CPU | ~$15-25 |
| VPC Connector | 2-3 instances e2-micro | ~$8-10 |
| Artifact Registry | Storage immagini | ~$1 |
| Secret Manager | 5 secrets | ~$0.30 |
| Cloud Build | ~30 build/mese (se usato) | ~$2-5 |
| **Totale** | | **~$175-190** (dopo trial AlloyDB: ~$175-190, durante trial: ~$25-40) |

**Ottimizzazione:** AlloyDB è il costo maggiore. Per app piccole considerare Cloud SQL PostgreSQL (da ~$7/mese per db-f1-micro) invece di AlloyDB.

---

## 16. Checklist rapida

### Setup iniziale (una tantum)
- [ ] Abilitare tutte le API necessarie
- [ ] Creare Private Services Access (IP range + VPC peering)
- [ ] Creare VPC Connector nella regione target
- [ ] Creare cluster AlloyDB con VPC Networking (non PSC)
- [ ] Creare istanza primaria AlloyDB
- [ ] Creare Artifact Registry
- [ ] Creare secrets in Secret Manager
- [ ] Creare SA per GitHub Actions con ruoli appropriati
- [ ] Configurare GitHub Secret `GCP_SA_KEY`

### Modifiche al codice
- [ ] Cambiare host da `127.0.0.1` a `0.0.0.0`
- [ ] Cambiare porta default a `8080`
- [ ] Aggiungere endpoint `/api/health`
- [ ] Creare `Dockerfile` multi-stage
- [ ] Creare `.dockerignore`
- [ ] Creare `cloudbuild.yaml` (deploy manuale)
- [ ] Creare `.github/workflows/deploy.yml` (CI/CD)
- [ ] Aggiornare `.gitignore` (escludere credenziali)

### Deploy e verifica
- [ ] Push su GitHub (trigger automatico) o deploy manuale
- [ ] Verificare health check: `curl https://URL/api/health`
- [ ] Verificare endpoint con dati dal DB
- [ ] Configurare dominio personalizzato (opzionale)
- [ ] Import dati nel database (se necessario)

### Pulizia
- [ ] Eliminare risorse Replit non più necessarie
- [ ] Eliminare VM temporanee usate per import
- [ ] Eliminare chiavi SA locali (`sa-key.json`)
- [ ] Verificare che nessun secret sia nel repository
