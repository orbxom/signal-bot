import type { McpServerDefinition } from '../types';
import { darkFactoryServer } from './darkFactory';
import { dossierServer } from './dossiers';
import { githubServer } from './github';
import { imagesServer } from './images';
import { memoryServer } from './memories';
import { messageHistoryServer } from './messageHistory';
import { notableDatesServer } from './notableDates';
import { personaServer } from './personas';
import { reminderServer } from './reminders';
import { settingsServer } from './settings';
import { signalServer } from './signal';
import { sourceCodeServer } from './sourceCode';
import { webAppsServer } from './webApps';
import { weatherServer } from './weather';

export const ALL_SERVERS: McpServerDefinition[] = [
  darkFactoryServer,
  githubServer,
  reminderServer,
  dossierServer,
  imagesServer,
  memoryServer,
  messageHistoryServer,
  notableDatesServer,
  weatherServer,
  sourceCodeServer,
  settingsServer,
  signalServer,
  personaServer,
  webAppsServer,
];
