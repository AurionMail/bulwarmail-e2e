import { AurionApiClient, AurionSession } from 'aurion-crypto-sdk';
import { AurionIndexedDBDriver } from 'aurion-crypto-sdk/';

export const aurionApi = new AurionApiClient(
  process.env.AURION_SERVER_URL || 'https://api.aurion.com'
);

// On exporte le driver pour pouvoir faire des getItem / setItem directement dans les stores de l'app
export const aurionStorage = new AurionIndexedDBDriver();

export const aurionSession = new AurionSession(aurionStorage);