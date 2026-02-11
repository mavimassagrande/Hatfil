#!/bin/bash
set -e

# IMPORTANTE: Usa progetto arkeplatform esistente
PROJECT_ID="arkeplatform"
REGION="europe-west1"
SERVICE_NAME="hatfil-app"

echo "🚀 Deploying Hatfil to Cloud Run..."

gcloud builds submit \
  --config=cloudbuild.yaml \
  --project=$PROJECT_ID \
  --region=$REGION

echo "✅ Deployment completed!"
echo "🌐 Service URL:"
gcloud run services describe $SERVICE_NAME \
  --region=$REGION \
  --project=$PROJECT_ID \
  --format="value(status.url)"
