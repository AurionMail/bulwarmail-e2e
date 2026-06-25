import { AurionApiClient, AurionSession } from 'aurion-crypto-sdk';
import { AurionIndexedDBDriver } from 'aurion-crypto-sdk/';
import { cryptoWorkerBridge } from './worker-bridge';

export const aurionApi = new AurionApiClient(
  process.env.AURION_SERVER_URL || 'https://api.aurion.com'
);

// On exporte le driver pour pouvoir faire des getItem / setItem directement dans les stores de l'app
export const aurionStorage = new AurionIndexedDBDriver();

export const aurionSession = new AurionSession(aurionStorage);

/**
 * Lance l'indexation globale et chirurgicale de la boîte mail en arrière-plan.
 * Récupère uniquement les couples {id, body} par lots pour nourrir MiniSearch via le Worker.
 */
export async function runInitialIndexing(client: any, targetAccountId: string): Promise<void> {
  // Est-ce que le coffre-fort UI est bien déverrouillé ?
  if (!aurionSession || !aurionSession.isUnlocked()) {
    console.warn("[Index Initial] Annulation : La session Aurion est verrouillée.");
    return;
  }

  //  Est-ce que le Worker est prêt à déchiffrer ?
  if (!cryptoWorkerBridge || !cryptoWorkerBridge.isInitialized) {
    console.warn("[Index Initial] Annulation : Le CryptoWorker n'est pas initialisé ou indisponible.");
    return;
  }

  const batchSize = 100;
  let position = 0;
  let hasMore = true;

  console.log("[Index Initial] Démarrage de l'extraction en arrière-plan...");

  try {
    while (hasMore) {
      // 1. On demande uniquement la liste des IDs au serveur (très léger)
      const queryResponse = await client.request([
        ["Email/query", {
          accountId: targetAccountId,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: batchSize,
          position: position,
        }, "0"]
      ]);

      const allIds = (queryResponse.methodResponses?.[0]?.[1]?.ids || []) as string[];
      if (allIds.length === 0) {
        hasMore = false;
        break;
      }

      // 2. On filtre pour ne garder que ceux qui ne sont pas dans l'index de l'UI
      const missingIds = allIds.filter((id: string) => !aurionSession.searchEngine.hasDocument(id));

      if (missingIds.length > 0) {
        // 3. On ne demande STRICTEMENT que l'id et le body chiffré
        const getResponse = await client.request([
          ["Email/get", {
            accountId: targetAccountId,
            ids: missingIds,
            properties: ["id", "body"]
          }, "0"]
        ]);

        const lightMails = (getResponse.methodResponses?.[0]?.[1]?.list || []) as Array<{ id: string, body: string }>;

        // 4. On envoie ce lot minimal au Worker pour déchiffrement + extraction des tokens
        await cryptoWorkerBridge.indexMailBatchAsync(lightMails);
      }

      position += allIds.length;
      hasMore = allIds.length === batchSize;
      
      // Pause de 30ms pour laisser le thread principal respirer
      await new Promise(resolve => setTimeout(resolve, 30));
    }

    // 5. Une fois TOUS les lots traités, on sauvegarde l'index final sur le disque local
    await aurionSession.saveSearchIndexToStorage();
    console.log("[Index Initial] Recherche 100% opérationnelle en local !");

  } catch (error) {
    console.error("[Index Initial] Erreur critique lors de l'indexation globale :", error);
  }
}