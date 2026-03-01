# Azure Deployment Guide

## Overview

Deploy the Signal bot to Azure Container Instances with Azure Container Registry for image storage. The bot uses Claude CLI (Max subscription) — no Azure OpenAI resources needed.

## Prerequisites

- Azure account
- Azure CLI installed (`az`)
- Docker installed locally
- Claude CLI authenticated locally (credentials will be deployed as a file share)

## Steps

### 1. Create Resource Group and Container Registry

```bash
az login

az group create --name signal-bot-rg --location australiaeast

az acr create --resource-group signal-bot-rg \
  --name signalbotacr --sku Basic
```

### 2. Build and Push Images

```bash
az acr login --name signalbotacr

# Build and push signal-cli
docker build -t signalbotacr.azurecr.io/signal-cli:latest ./signal-cli
docker push signalbotacr.azurecr.io/signal-cli:latest

# Build and push bot
docker build -t signalbotacr.azurecr.io/bot:latest ./bot
docker push signalbotacr.azurecr.io/bot:latest
```

### 3. Create Storage

```bash
az storage account create \
  --resource-group signal-bot-rg \
  --name signalbotstore \
  --sku Standard_LRS

az storage share create --name signal-data --account-name signalbotstore
az storage share create --name bot-data --account-name signalbotstore
az storage share create --name claude-config --account-name signalbotstore
```

Upload Claude CLI auth from your local machine:
```bash
# Upload ~/.claude directory contents to the claude-config share
az storage file upload-batch \
  --destination claude-config \
  --source ~/.claude \
  --account-name signalbotstore
```

### 4. Deploy Container Group

```bash
az container create --resource-group signal-bot-rg \
  --name signal-bot \
  --image signalbotacr.azurecr.io/bot:latest \
  --registry-login-server signalbotacr.azurecr.io \
  --registry-username signalbotacr \
  --registry-password "$(az acr credential show --name signalbotacr --query passwords[0].value -o tsv)" \
  --environment-variables \
    BOT_PHONE_NUMBER="+61YOURPHONE" \
    SIGNAL_CLI_URL="http://localhost:8080" \
    MENTION_TRIGGERS="@bot" \
  --azure-file-volume-account-name signalbotstore \
  --azure-file-volume-share-name claude-config \
  --azure-file-volume-mount-path /root/.claude \
  --cpu 1 --memory 1.5 \
  --restart-policy Always \
  --os-type Linux
```

### 5. Monitor

```bash
# View logs
az container logs --resource-group signal-bot-rg --name signal-bot

# Check status
az container show --resource-group signal-bot-rg --name signal-bot --query instanceView.state
```

### 6. Cleanup

```bash
az group delete --name signal-bot-rg --yes
```
