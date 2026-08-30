import axios from 'axios';

function cleanAndParseJSON(text) {
  let cleaned = text.trim();
  const codeFenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeFenceMatch) cleaned = codeFenceMatch[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (e) { /* fall through */ }
    }
    throw new Error('Gemini did not return valid JSON: ' + err.message);
  }
}

const FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-2.5-flash'];

async function callGemini(apiKey, model, systemInstruction, prompt, responseJson = false) {
  const chain = [model, ...FALLBACK_MODELS.filter(m => m !== model)];
  let lastError = null;
  for (const m of chain) {
    try {
      return await callGeminiModel(apiKey, m, systemInstruction, prompt, responseJson);
    } catch (err) {
      lastError = err;
      const overloaded = /high demand|overloaded|UNAVAILABLE|503/i.test(err.message);
      if (!overloaded) throw err;
      console.warn(`[Gemini] Model ${m} overloaded, falling back...`);
    }
  }
  throw lastError;
}

async function callGeminiModel(apiKey, model, systemInstruction, prompt, responseJson) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: responseJson ? { responseMimeType: 'application/json' } : {}
  };
  if (systemInstruction) payload.systemInstruction = { parts: [{ text: systemInstruction }] };

  let attempts = 0;
  const maxAttempts = 3;
  let delay = 1500;
  while (attempts < maxAttempts) {
    try {
      attempts++;
      const response = await axios.post(url, payload, { timeout: 45000 });
      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return responseJson ? cleanAndParseJSON(text) : text;
    } catch (error) {
      const status = error.response?.status;
      const isRetryable = status === 429 || status === 503 || error.code === 'ECONNRESET' || error.message.includes('timeout');
      if (isRetryable && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2.5;
      } else {
        const errMsg = error.response?.data?.error?.message || error.message;
        throw new Error(`Gemini API call failed: ${errMsg}`);
      }
    }
  }
}

/** Summarize a WhatsApp chat log into a short structured digest (Hebrew). */
export async function summarizeMessages(apiKey, messagesText, chatName) {
  const systemInstruction = 'You are an advanced AI assistant that specializes in reading WhatsApp work-group chat logs and summarizing them into structured insights in Hebrew. Focus on updates, decisions, and follow-up tasks. Ignore small talk.';
  const schema = `{
  "summary": "סיכום קצר (עד 3 שורות) של עדכוני היום",
  "topics": [ { "topic": "נושא מרכזי", "bullets": ["פירוט הנושא והחלטות"] } ],
  "actionItems": [ { "task": "המשימה הנדרשת לביצוע", "assignee": "האחראי לביצוע", "deadline": "תאריך יעד בפורמט YYYY-MM-DD אם יש" } ],
  "decisions": ["החלטה 1 שהתקבלה"]
}`;
  const prompt = `נתח את יומן ההודעות הבא מקבוצת הוואטסאפ "${chatName}".
תאריך היום: ${new Date().toISOString().slice(0, 10)}.
החזר אך ורק אובייקט JSON התואם לסכימה:
${schema}

יומן ההודעות:
${messagesText}`;
  return callGemini(apiKey, 'gemini-3.5-flash', systemInstruction, prompt, true);
}

/** Format a JSON summary into a Hebrew WhatsApp-ready text message. */
export function formatSummaryForWhatsApp(chatName, summaryData) {
  let text = `*📊 סיכום יומי - ${chatName}*\n`;
  text += `_${new Date().toLocaleDateString('he-IL')}_\n\n`;
  if (summaryData.summary) text += `📝 *תקציר:*\n${summaryData.summary}\n\n`;
  if (summaryData.topics?.length) {
    text += `🔍 *נושאים מרכזיים:*\n`;
    summaryData.topics.forEach(t => {
      text += `• *${t.topic}*:\n`;
      (t.bullets || []).forEach(b => { text += `  - ${b}\n`; });
    });
    text += `\n`;
  }
  if (summaryData.actionItems?.length) {
    text += `✅ *משימות לביצוע:*\n`;
    summaryData.actionItems.forEach(a => {
      const deadline = a.deadline ? ` (יעד: ${a.deadline})` : '';
      const assignee = a.assignee ? ` [אחראי: ${a.assignee}]` : '';
      text += `• ${a.task}${assignee}${deadline}\n`;
    });
    text += `\n`;
  }
  if (summaryData.decisions?.length) {
    text += `🤝 *החלטות שהתקבלו:*\n`;
    summaryData.decisions.forEach(d => { text += `• ${d}\n`; });
    text += `\n`;
  }
  text += `🤖 _סוכם אוטומטית ע"י דשבורד הוואטסאפ_`;
  return text;
}

/** Draft an auto-reply suggestion for an incoming 1:1 message. Never sent directly — always goes to the approval queue. */
export async function draftAutoReply(apiKey, { senderName, incomingMessage, faqs, isKnownContact }) {
  const faqText = (faqs || []).map(f => `ש: ${f.question}\nת: ${f.answer}`).join('\n\n') || 'אין שאלות נפוצות מוגדרות.';
  const systemInstruction = `אתה עוזר אישי שמנסח טיוטת תשובה קצרה, מנומסת ומקצועית בעברית להודעת וואטסאפ שהתקבלה.
זו טיוטה בלבד שתעבור אישור אנושי לפני שליחה - אם אינך בטוח בתשובה, נסח תשובה כללית שמבקשת סבלנות/מפנה לבירור נוסף, ואל תמציא פרטים שלא נמסרו לך.
השתמש ברשימת שאלות ותשובות נפוצות הבאה כמקור אמת כשרלוונטי:
${faqText}`;
  const contactContext = isKnownContact
    ? `השולח, ${senderName}, נמצא ברשימת אנשי הקשר המאושרים למענה אוטומטי.`
    : `השולח, ${senderName}, אינו איש קשר שמור - זהו מספר לא מוכר ששאל שאלה שתואמת לשאלה נפוצה.`;
  const prompt = `${contactContext}\n\nההודעה שהתקבלה:\n"${incomingMessage}"\n\nנסח טיוטת תשובה קצרה (2-4 משפטים) בעברית.`;
  return callGemini(apiKey, 'gemini-3.5-flash', systemInstruction, prompt, false);
}
