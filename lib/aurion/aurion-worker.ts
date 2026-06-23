import { AurionSession } from 'aurion-crypto-sdk';
import { EmailBodyValue } from '../jmap/types';

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

  // --- TRAITEMENT DU FLUX ENTRANT ---
  if (action === 'DECRYPT_BATCH') {
    try {
      const { emails } = data;
      const processedEmails = [];

      for (const email of emails) {
        const processedEmail = { ...email };

        // 1. Déchiffrement du corps des messages (getEmail)
        if (processedEmail.bodyValues) {
          const updatedBodyValues: Record<string, EmailBodyValue> = { ...processedEmail.bodyValues };
         
          let isDecrypted = false;

          for (const partId in updatedBodyValues) {
            const bodyValue = updatedBodyValues[partId];
            
            if (bodyValue && bodyValue.value.includes('-----BEGIN PGP MESSAGE-----')) {
              const clearText = await workerSession.decryptCiphertext(bodyValue.value, processedEmail.accountLabel);
              
              // FIX: Deep copy de l'objet EmailBodyValue pour éviter de muter la référence d'origine
              updatedBodyValues[partId] = {
                ...bodyValue,
                value: clearText,
                isTruncated: false
              };
              isDecrypted = true;
            }
          }
          
          if (isDecrypted) {
            processedEmail.bodyValues = updatedBodyValues;
            const bodyParts = Object.values(updatedBodyValues) as EmailBodyValue[];
            const mainTextPart = bodyParts[0]?.value || '';
            processedEmail.preview = mainTextPart.slice(0, 200).replace(/\s+/g, ' ') + '...';
          }
        }

        // 2. Déchiffrement des métadonnées de liste (getEmails)
        if (processedEmail.preview && processedEmail.preview.includes('-----BEGIN PGP MESSAGE-----')) {
          try {
            processedEmail.preview = await workerSession.decryptCiphertext(processedEmail.preview, processedEmail.accountLabel);
          } catch (_) {
            processedEmail.preview = "[Message Chiffré]";
          }
        }
        
        if (processedEmail.subject && processedEmail.subject.includes('-----BEGIN PGP MESSAGE-----')) {
          try {
            processedEmail.subject = await workerSession.decryptCiphertext(processedEmail.subject, processedEmail.accountLabel);
          } catch (_) {
            processedEmail.subject = "[Sujet Chiffré]";
          }
        }

        processedEmails.push(processedEmail);
      }

      self.postMessage({ id, success: true, data: processedEmails });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      self.postMessage({ id, success: false, error: "Worker Keyring decryption failed: " + errorMessage });
    }
  }
};