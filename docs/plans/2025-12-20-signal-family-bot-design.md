# Signal Family Bot Design

**Date:** 2025-12-20
**Purpose:** LLM-powered assistant bot for family Signal group chat

## Overview

An Azure-hosted Signal bot that responds to mentions in a family group chat using Azure OpenAI. The bot maintains conversation context via sliding window and runs in Docker containers on Azure Container Instances.

## Requirements

- Respond only when mentioned (@bot or bot:)
- Use Azure OpenAI (leveraging $150/month credits)
- Remember recent messages (sliding window of ~20 messages)
- Use Australian phone number for bot registration
- Deploy as Docker containers in Azure
- Built with TypeScript/Node.js

## Architecture

### System Components

1. **signal-cli container**
   - Handles Signal protocol communication
   - Runs as daemon with JSON-RPC API on localhost:8080
   - Manages encryption, message sending/receiving, registration

2. **Bot application container** (TypeScript/Node.js)
   - Listens for messages from signal-cli
   - Detects mentions and extracts queries
   - Manages conversation context
   - Calls Azure OpenAI API
   - Sends responses via signal-cli

3. **Storage** (SQLite in mounted volume)
   - Message history per group (20 message sliding window)
   - Bot configuration (triggers, system prompt)
   - State management

4. **Docker Compose**
   - Orchestrates both containers
   - Shared network and volumes
   - Environment variable management
   - Health checks and auto-restart

### Communication Flow

```
Signal Network → signal-cli → JSON-RPC → Bot App → Azure OpenAI API
                                            ↓
                                      SQLite Storage
```

## Message Processing

### Incoming Message Flow

1. **Reception:** signal-cli receives and forwards via webhook/polling
2. **Mention Detection:** Check for @bot, bot:, or custom triggers
3. **Context Retrieval:** Load last 20 messages from SQLite
4. **LLM Call:** Send context + query to Azure OpenAI
5. **Response:** Send reply via signal-cli, store in history

### Context Management

- Maintain sliding window of 20 messages per group
- Format as conversation history with sender names
- Keep within ~4000 token budget
- FIFO trimming when limit exceeded

### Error Handling

- Azure API failures → friendly error message
- Long responses → truncate or split messages
- Rate limiting per user to prevent spam

## Deployment

### Directory Structure

```
signal-bot/
├── docker-compose.yml
├── signal-cli/
│   └── Dockerfile
├── bot/
│   ├── Dockerfile (Node.js 20 Alpine)
│   ├── package.json
│   ├── src/
│   │   ├── index.ts
│   │   ├── signalClient.ts
│   │   ├── azureOpenAI.ts
│   │   ├── storage.ts
│   │   └── messageHandler.ts
│   └── tsconfig.json
└── data/
    ├── signal-cli-config/
    └── bot.db
```

### Azure Container Instances

**Setup:**
- Azure Container Registry for images
- Container group with both containers
- Azure File Share for persistence
- Environment variables from Key Vault
- No public IP needed

**Environment Variables:**
```
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_KEY=<from Key Vault>
AZURE_OPENAI_DEPLOYMENT=gpt-4o
BOT_PHONE_NUMBER=<Australian number>
MENTION_TRIGGERS=@bot,bot:
CONTEXT_WINDOW_SIZE=20
```

### Signal Registration (One-time)

1. Exec into signal-cli container
2. Run `signal-cli -a +61... register`
3. Verify with SMS code
4. Add bot to family group
5. Set profile name/avatar

## Configuration

### Bot Behavior

- **System prompt:** Customizable personality
- **Temperature:** 0.7 (balanced creativity)
- **Max response length:** Configurable
- **Rate limits:** 10 messages/person/hour
- **Mention triggers:** Multiple patterns supported

### Logging & Monitoring

**Application Logs:**
- Structured JSON to stdout
- Track: messages, LLM calls, errors, timing

**Azure Monitor:**
- Container logs auto-collected
- Alerts for crashes, API errors, high usage
- Optional Application Insights

**Health Checks:**
- HTTP /health endpoint
- Validates signal-cli and Azure OpenAI connectivity
- Docker auto-restart on failure

## Cost Estimates (Monthly)

- **Azure Container Instances:** $10-15 (1 vCPU, 1.5GB RAM)
- **Azure OpenAI API:**
  - GPT-4o: ~$3-9 (300 msgs/month)
  - GPT-3.5-turbo: ~$0.60 (300 msgs/month)
- **Storage:** <$1
- **Total:** $14-25/month (within $150 credits)

## Security

- Azure Key Vault for API keys
- signal-cli data encrypted at rest
- No public endpoints
- Consider Managed Identity for Azure access

## Development

### Local Setup

1. Docker & Docker Compose
2. Node.js 20+
3. Azure OpenAI credentials
4. Australian phone number

### Workflow

- `docker-compose up` for local testing
- File watching with nodemon/tsx
- SQLite inspection in ./data/
- `.env.local` for secrets (gitignored)

### Testing

- **Manual:** Send messages from Signal app
- **Unit:** Message parsing, context building
- **Integration:** Mock signal-cli and Azure API
- **Dev/Test:** Use gpt-3.5-turbo deployment

### Initial Setup Checklist

- [ ] Register Australian number with signal-cli
- [ ] Verify registration with SMS
- [ ] Set bot profile
- [ ] Add to family group
- [ ] Test @bot mention
- [ ] Verify response
- [ ] Check logs
- [ ] Monitor Azure costs

## Future Enhancements (Optional)

- Voice message transcription (Azure Speech)
- Image analysis (Azure Computer Vision)
- Scheduled messages (birthdays, reminders)
- Admin commands (/reload, /status, /clear-context)
- Multi-group support
- Conversation threading
- Per-member personality customization

## Rollback & Recovery

- Tagged Docker images in ACR
- Azure File Share snapshots for backups
- Document signal-cli re-registration
- Backup linked device QR code
