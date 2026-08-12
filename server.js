// ============================================================================
// EpiLife Alarm Server
// Roda a cada minuto, verifica os medicamentos de todos os usuarios e dispara
// uma notificacao push (FCM) para quem tiver um horario batendo com "agora"
// (fuso horario America/Sao_Paulo). E o que faz o alarme "tocar" mesmo com
// o app fechado, porque o navegador/PWA sozinho nao consegue.
// ============================================================================

const express = require('express');
const cron = require('node-cron');
const admin = require('firebase-admin');

// ── 1. Inicializa o Firebase Admin ──────────────────────────────────────────
// No Render, defina a variavel de ambiente FIREBASE_SERVICE_ACCOUNT com o
// CONTEUDO INTEIRO do arquivo JSON da service account (Firebase Console >
// Configuracoes do projeto > Contas de servico > Gerar nova chave privada).
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('[EpiLife] ERRO: variavel FIREBASE_SERVICE_ACCOUNT ausente ou invalida.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const messaging = admin.messaging();

// ── 2. Evita reenviar o mesmo alarme duas vezes no mesmo minuto ────────────
// (o cron pode disparar levemente atrasado/duplicado em raras situacoes)
const sentToday = new Set();
let sentTodayDate = '';

function resetSentIfNewDay(dateStr) {
  if (sentTodayDate !== dateStr) {
    sentTodayDate = dateStr;
    sentToday.clear();
  }
}

// ── 3. Horario atual em America/Sao_Paulo, formato "HH:MM" e "YYYY-MM-DD" ──
function getNowSaoPaulo() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now);

  const get = (type) => parts.find(p => p.type === type).value;
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  const timeStr = `${get('hour')}:${get('minute')}`;
  return { dateStr, timeStr };
}

// ── 4. Envia o push de um alarme ────────────────────────────────────────────
async function sendAlarmPush(fcmToken, med, time, uid) {
  const message = {
    token: fcmToken,
    notification: {
      title: '💊 Hora do remédio',
      body: `${med.name}${med.dose ? ' — ' + med.dose : ''} (${time})`
    },
    data: {
      type: 'ALARM',
      medId: med.id || '',
      medName: med.name || '',
      dose: med.dose || '',
      time: time
    },
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'epilife_alarms',
        priority: 'max',
        visibility: 'public'
      }
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: {
        aps: {
          sound: 'default',
          'content-available': 1,
          'interruption-level': 'time-sensitive'
        }
      }
    },
    webpush: {
      headers: { Urgency: 'high' },
      notification: {
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 300]
      }
    }
  };

  try {
    await messaging.send(message);
    console.log(`[EpiLife] Push enviado -> uid=${uid} med=${med.name} time=${time}`);
  } catch (err) {
    console.error(`[EpiLife] Falha ao enviar push -> uid=${uid} med=${med.name}:`, err.message);
    // Token invalido/expirado: limpa do Firestore para nao tentar de novo
    if (err.code === 'messaging/registration-token-not-registered') {
      await db.collection('users').doc(uid).update({ fcmToken: admin.firestore.FieldValue.delete() }).catch(() => {});
    }
  }
}

// ── 5. Varredura principal: roda a cada minuto ──────────────────────────────
async function checkAlarms() {
  const { dateStr, timeStr } = getNowSaoPaulo();
  resetSentIfNewDay(dateStr);

  try {
    const usersSnap = await db.collection('users').get();

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const userData = userDoc.data();
      const fcmToken = userData.fcmToken;
      if (!fcmToken) continue;

      const medsSnap = await db.collection('users').doc(uid).collection('meds').get();

      for (const medDoc of medsSnap.docs) {
        const med = { id: medDoc.id, ...medDoc.data() };
        const times = med.times || [];

        if (times.includes(timeStr)) {
          const dedupeKey = `${uid}_${med.id}_${timeStr}`;
          if (sentToday.has(dedupeKey)) continue;
          sentToday.add(dedupeKey);

          await sendAlarmPush(fcmToken, med, timeStr, uid);
        }
      }
    }
  } catch (err) {
    console.error('[EpiLife] Erro na varredura de alarmes:', err);
  }
}

// ── 6. Agenda a checagem para todo minuto ───────────────────────────────────
cron.schedule('* * * * *', checkAlarms, { timezone: 'America/Sao_Paulo' });
console.log('[EpiLife] Cron de alarmes iniciado (verifica a cada minuto).');

// ── 7. Servidor HTTP simples, so para health-check e manter o serviço vivo ─
const app = express();
app.get('/', (req, res) => {
  const { dateStr, timeStr } = getNowSaoPaulo();
  res.json({ status: 'ok', service: 'epilife-alarm-server', now: `${dateStr} ${timeStr}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[EpiLife] Health-check ouvindo na porta ${PORT}`));
