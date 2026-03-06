import type { McpServerDefinition } from '../types';
import { dossierServer } from './dossiers';
import { githubServer } from './github';
import { messageHistoryServer } from './messageHistory';
import { personaServer } from './personas';
import { reminderServer } from './reminders';
import { signalServer } from './signal';
import { sourceCodeServer } from './sourceCode';
import { weatherServer } from './weather';

export const ALL_SERVERS: McpServerDefinition[] = [
  githubServer,
  reminderServer,
  dossierServer,
  messageHistoryServer,
  weatherServer,
  sourceCodeServer,
  signalServer,
  personaServer,
];
