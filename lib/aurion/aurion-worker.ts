import { AurionSession } from 'aurion-crypto-sdk';
import { EmailBodyValue } from '../jmap/types';
import * as openpgp from 'openpgp'; // Nécessaire pour lire les fingerprints locaux

// Le worker gère sa propre session et son searchEngine en RAM
const workerSession = new AurionSession(null); 

self.onmessage = async (event) => {
  const { id, action, data } = event.data;

  // --- ACTIONS D'INITIALISATION ---
  if (action === 'INIT_SESSION') {
    try {
      const { encryptedKeys, saltClient } = data;
      
      if (data.h0) {
        workerSession.h0 = new Uint8Array(data.h0);
      }

      await workerSession.decryptAndLoadPrivateKeys(encryptedKeys, saltClient);

      self.postMessage({ id, success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      self.postMessage({ id, success: false, error: "Worker Keyring decryption failed: " + errorMessage });
    }
    return;
  }

  // --- TRAITEMENT DU FLUX ENTRANT (GETEMAIL / GETEMAILS) ---
  if (action === 'DECRYPT_BATCH') {
    console.log("[AURION-WORKER]  Début DECRYPT_BATCH reçu. Nombre d'emails:", data?.emails?.length);
    try {
      const { emails } = data;
      const processedEmails = [];
      const indexUpdates = []; 

      for (const email of emails) {
        console.log(`[AURION-WORKER]  Traitement de l'email ID: ${email.id}, Sujet: ${email.subject}`);
        const processedEmail = { ...email };
        let clearTextBody: string | null = null;
        let isPgpMimeGlobal = false;

        if (processedEmail.bodyValues) {
          console.log(`[AURION-WORKER] [${email.id}] bodyValues détecté. Clés disponibles:`, Object.keys(processedEmail.bodyValues));
          const updatedBodyValues: Record<string, EmailBodyValue> = { ...processedEmail.bodyValues };
          let isDecrypted = false;

          for (const partId in updatedBodyValues) {
            const bodyValue = updatedBodyValues[partId];
            if (!bodyValue) {
              console.log(`[AURION-WORKER] [${email.id}] Clé ${partId} vide ou nulle.`);
              continue;
            }

            console.log(`[AURION-WORKER] [${email.id}][Part:${partId}] Analyse du contenu (Taille: ${bodyValue.value?.length} caractères)`);
            
            // Détection 1 : Format Inline (Ancien)
            const isInlinePGP = bodyValue.value.includes('-----BEGIN PGP MESSAGE-----');
            // Détection 2 : Format PGP/MIME via notre clé artificielle injectée dans getEmail
            const isPgpMime = partId === 'mime-heavy-payload' || 
                              bodyValue.value.includes('application/pgp-encrypted') || 
                              bodyValue.value.includes('encrypted.asc');

            console.log(`[AURION-WORKER] [${email.id}][Part:${partId}] Verdict détection -> isInlinePGP: ${isInlinePGP}, isPgpMime: ${isPgpMime}`);

            if (isInlinePGP || isPgpMime) {
              if (partId === 'mime-heavy-payload' || isPgpMime) {
                isPgpMimeGlobal = true;
              }

              try {
                console.log(`[AURION-WORKER] [${email.id}][Part:${partId}]  Lancement de workerSession.decryptCiphertext...`);
                // Début de l'aperçu du payload pour voir s'il y a des caractères étranges
                console.log(`[AURION-WORKER] [${email.id}][Part:${partId}] Début du payload chiffré:`, bodyValue.value.substring(0, 150));
                
                clearTextBody = await workerSession.decryptCiphertext(bodyValue.value, processedEmail.accountLabel);
                
                console.log(`[AURION-WORKER] [${email.id}][Part:${partId}]  Déchiffrement réussi ! Longueur du clair: ${clearTextBody?.length}`);
                
                updatedBodyValues[partId] = {
                  ...bodyValue,
                  value: clearTextBody,
                  isTruncated: false
                };
                isDecrypted = true;
              } catch (decryptError) {
                console.error(`[AURION-WORKER]  ERREUR CRITIQUE pendant le decryptCiphertext de la clé ${partId}:`, decryptError);
                throw decryptError; // On rethrow pour que le catch global affiche la stacktrace
              }
            } else {
              console.log(`[AURION-WORKER] [${email.id}][Part:${partId}] Contenu non chiffré détecté.`);
              clearTextBody = bodyValue.value;
            }
          }
          
          if (isDecrypted) {
            processedEmail.bodyValues = updatedBodyValues;
            if (isPgpMimeGlobal) {
              processedEmail.preview = "[Message Sécurisé]";
            } else {
              const bodyParts = Object.values(updatedBodyValues) as EmailBodyValue[];
              const mainTextPart = bodyParts[0]?.value || '';
              processedEmail.preview = mainTextPart.slice(0, 200).replace(/\s+/g, ' ') + '...';
            }
          }
        }

        // ALIMENTATION DE L'INDEX LOCAL DU WORKER
        if (clearTextBody) {
          try {
            console.log(`[AURION-WORKER] [${email.id}]  Indexation locale du message...`);
            const indexableText = isPgpMimeGlobal 
              ? clearTextBody.replace(/^[\s\S]*?\r?\n\r?\n/, "") 
              : clearTextBody;

            workerSession.searchEngine.indexMail(processedEmail.id, [], indexableText);
            const tokens = workerSession.extractSearchTokens(indexableText);
            indexUpdates.push({ id: processedEmail.id, tokens });
            console.log(`[AURION-WORKER] [${email.id}] Indexation terminée (${tokens.length} tokens extraits).`);
          } catch (indexError) {
            console.error(`[AURION-WORKER]  Erreur pendant l'indexation de l'email ${email.id}:`, indexError);
            // On ne bloque pas tout le batch si seule l'indexation d'un mail foire
          }
        }

        // 2. Déchiffrement des métadonnées de liste (preview / subject) si elles sont Inline
        if (processedEmail.preview && processedEmail.preview.includes('-----BEGIN PGP MESSAGE-----')) {
          try {
            console.log(`[AURION-WORKER] [${email.id}] Déchiffrement de la preview de liste...`);
            processedEmail.preview = await workerSession.decryptCiphertext(processedEmail.preview, processedEmail.accountLabel);
          } catch (_) {
            processedEmail.preview = "[Message Chiffré]";
          }
        }
        
        if (processedEmail.subject && processedEmail.subject.includes('-----BEGIN PGP MESSAGE-----')) {
          try {
            console.log(`[AURION-WORKER] [${email.id}] Déchiffrement du sujet de liste...`);
            processedEmail.subject = await workerSession.decryptCiphertext(processedEmail.subject, processedEmail.accountLabel);
          } catch (_) {
            processedEmail.subject = "[Sujet Chiffré]";
          }
        }

        processedEmails.push(processedEmail);
      }

      console.log("[AURION-WORKER] 🚀 Fin DECRYPT_BATCH réussie. Envoi des données remontées à l'UI.");
      self.postMessage({ 
        id, 
        success: true, 
        data: { 
          emails: processedEmails, 
          indexUpdates 
        } 
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : 'No stacktrace';
      console.error("[AURION-WORKER] 🔥 ERREUR FINALE CAPTURÉE DANS LE WORKER:", errorMessage, errorStack);
      self.postMessage({ id, success: false, error: "Worker decryption batch failed: " + errorMessage });
    }
    return;
  }

  // --- ⚡ INDEXATION GLOBALE INITIALE OU EN ARRIÈRE-PLAN ---
  if (action === 'INDEX_BATCH_SILENT') {
    try {
      const { encryptedMails } = data; // Contient un tableau de { id, body }
      const indexUpdates = [];

      for (const mail of encryptedMails) {
        if (mail.body && mail.body.includes('-----BEGIN PGP MESSAGE-----')) {
          try {
            const clearTextBody = await workerSession.decryptCiphertext(mail.body);
            
            // Indexation locale au Worker
            workerSession.searchEngine.indexMail(mail.id, [], clearTextBody);
            
            // Extraction pour l'UI
            const tokens = workerSession.extractSearchTokens(clearTextBody);
            indexUpdates.push({ id: mail.id, tokens });
          } catch (e) {
            console.warn(`[Worker Index] Impossible de déchiffrer le mail ${mail.id} pour indexation:`, e);
          }
        }
      }

      self.postMessage({ id, success: true, data: { indexUpdates } });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      self.postMessage({ id, success: false, error: "Worker silent indexing failed: " + errorMessage });
    }
    return;
  
  }


if (action === 'GENERATE_AND_SHARE_KEYS') {
  try {
    const { identityId, email, members } = data; // members: Array<{ user_id, public_key }>

    // Utilisation de la méthode adaptée qui prend les ID utilisateurs
    const groupMaterial = await workerSession.generateGroupKeys(email, members);

    // On renvoie directement le payload prêt à être consommé par l'API Go
    self.postMessage({
      id,
      success: true,
      data: {
        identity_id: identityId,
        armored_public_key: groupMaterial.groupPublicKeyArmored,
        shares: groupMaterial.shares
      }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    self.postMessage({ 
      id, // 💡 CORRECTION : On passe le vrai 'id' reçu, pas le booléen 'false'
      success: false, 
      error: "Worker SDK key generation failed: " + errorMessage 
    });
  }
  return;
}
};