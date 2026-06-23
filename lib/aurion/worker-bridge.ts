import { Email } from '../jmap/types';

class CryptoWorkerBridge {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, { resolve: (value: any) => void; reject: (reason: any) => void }> = new Map();
  private isInitialized: boolean = false;

  constructor() {
    if (typeof window !== 'undefined') {
      // Next.js va intercepter cette syntaxe et compiler le Worker (et ses dépendances Node) automatiquement !
      this.worker = new Worker(new URL('./aurion-worker.ts', import.meta.url), {
        type: 'module',
      });
      
      this.worker.onmessage = (event) => {
        const { id, success, data, error } = event.data;
        const promise = this.pendingRequests.get(id);
        
        if (promise) {
          if (success) {
            promise.resolve(data);
          } else {
            promise.reject(new Error(error));
          }
          this.pendingRequests.delete(id);
        }
      };
    }
  }

/**
   * Initialise le Worker en lui passant les clés chiffrées et le matériel de dérivation
   */
  public async initWorkerSession(
    encryptedKeys: Array<{ encrypted_private_key: string; identity_email?: string }>, 
    saltClient: string,
    h0: Uint8Array | null
  ): Promise<void> {
    if (!this.worker) return;

    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.pendingRequests.set(requestId, {
        resolve: () => {
          this.isInitialized = true;
          resolve();
        },
        reject
      });

      this.worker!.postMessage({
        id: requestId,
        action: 'INIT_SESSION',
        data: { 
          encryptedKeys, 
          saltClient,
          // On passe le buffer sous-jacent de h0 pour le cloner proprement
          h0: h0 ? h0.buffer : null 
        }
      });
    });
  }

  public async processMailBatchAsync(emails: Email[]): Promise<Email[]> {
    // Si le worker n'est pas prêt ou pas initialisé, on évite de bloquer l'UI
    if (!this.worker || !this.isInitialized || emails.length === 0) return emails;

    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.pendingRequests.set(requestId, { resolve, reject });

      this.worker!.postMessage({
        id: requestId,
        action: 'DECRYPT_BATCH',
        data: { emails }
      });
    });
  }
}

export const cryptoWorkerBridge = new CryptoWorkerBridge();