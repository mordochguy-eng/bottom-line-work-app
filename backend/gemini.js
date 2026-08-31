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

async function callGemini(apiKey, model, systemInstruction, prompt, responseJson = false, inlineDataParts = []) {
  const chain = [model, ...FALLBACK_MODELS.filter(m => m !== model)];
  let lastError = null;
  for (const m of chain) {
    try {
      return await callGeminiModel(apiKey, m, systemInstruction, prompt, responseJson, inlineDataParts);
    } catch (err) {
      lastError = err;
      const overloaded = /high demand|overloaded|UNAVAILABLE|503/i.test(err.message);
      if (!overloaded) throw err;
      console.warn(`[Gemini] Model ${m} overloaded, falling back...`);
    }
  }
  throw lastError;
}

async function callGeminiModel(apiKey, model, systemInstruction, prompt, responseJson, inlineDataParts = []) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }, ...inlineDataParts] }],
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
  "actionItems": [ { "task": "המשימה הנדרשת לביצוע", "assignee": "האחראי לביצוע", "category": "קטגוריית הבקשה בעברית, למשל הצעת מחיר/בדיקת זכאות/מענה נדרש/תיאום פגישה/תשלום/מסמך אישור", "deadline": "תאריך יעד בפורמט YYYY-MM-DD אם יש", "messageDate": "תאריך ההודעה המקורית שבה המשימה נרשמה, בפורמט YYYY-MM-DD" } ],
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

/**
 * Historical scan: reads a whole chat's recent transcript in one call and
 * pulls out every message that needed action from the owner. One call per
 * chat (not per message) — much cheaper than analyzing each message
 * individually when scanning days of backlog.
 */
export async function scanChatForActions(apiKey, { chatName, isGroup, messages }) {
  const systemInstruction = `אתה עוזר שסורק שיחת וואטסאפ ${isGroup ? 'קבוצתית' : 'אישית'} ומזהה אילו הודעות ספציפיות דרשו פעולה מבעל החשבון (מענה, ביצוע בקשה, מתן הצעת מחיר, בדיקת זכאות, עמידה בדדליין וכו').
התעלם משיחת חולין ומהודעות שכבר טופלו במהלך השיחה עצמה (למשל אם מישהו אחר בשיחה כבר ענה, או אם בעל החשבון עצמו - המסומן "אני" - כבר הגיב). אם אינך בטוח, אל תכלול - עדיף לפספס מקרה גבולי מאשר להציף ברשימת המשימות.
לכל פריט קבע קטגוריה קצרה שמאפיינת את סוג הבקשה - למשל "הצעת מחיר", "בדיקת זכאות", "מענה נדרש", "תיאום פגישה", "תשלום", "מסמך/אישור", או קטגוריה מתאימה אחרת בעברית.`;
  const schema = `{ "items": [ { "task": "תיאור קצר וברור של מה שצריך לעשות", "sender": "שם השולח של ההודעה הרלוונטית", "category": "קטגוריית הבקשה בעברית", "deadline": "תאריך יעד בפורמט YYYY-MM-DD אם צוין, אחרת null", "messageDate": "תאריך ההודעה הרלוונטית עצמה (מהתמליל) בפורמט YYYY-MM-DD" } ] }`;
  const transcript = messages
    .map(m => `[${new Date(m.timestamp * 1000).toLocaleString('he-IL')}] ${m.senderName}: ${m.text}`)
    .join('\n');
  const prompt = `שיחה עם/בקבוצה "${chatName}":\n${transcript}\n\nתאריך היום: ${new Date().toISOString().slice(0, 10)}.\nהחזר אך ורק אובייקט JSON התואם לסכימה: ${schema}\nאם אין הודעות שדורשות פעולה, החזר items: []`;
  return callGemini(apiKey, 'gemini-3.5-flash', systemInstruction, prompt, true);
}

/**
 * Recurring-motif analysis: given a pile of incoming questions/messages
 * from one segment (e.g. "unsaved individuals"), finds repeated themes and
 * proposes ready-to-use FAQ entries for the auto-reply feature. One call
 * per segment at the end of a history scan, not per chat.
 */
export async function identifyRecurringMotifs(apiKey, { segmentLabel, questions }) {
  const systemInstruction = `אתה עוזר שמנתח אוסף הודעות/שאלות שהתקבלו בוואטסאפ מקבוצת שולחים בשם "${segmentLabel}", ומזהה מוטיבים ושאלות שחוזרות על עצמן מספר פעמים.
עבור כל מוטיב חוזר, נסח שאלה נפוצה מייצגת (בעברית, בגוף שני - איך אדם היה שואל אותה) ותשובה קצרה, ברורה ומקצועית שמתאימה לענות בה באופן כללי לכל מי ששואל שאלה דומה.
כלול רק מוטיבים שחזרו בפועל אצל כמה שולחים שונים או בכמה הזדמנויות - אל תמציא שאלה על סמך הודעה בודדת.`;
  const schema = `{ "faqSuggestions": [ { "question": "השאלה הנפוצה בעברית", "answer": "תשובה מוצעת בעברית", "category": "קטגוריה קצרה", "count": 0 } ] }`;
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const prompt = `רשימת ${questions.length} הודעות/שאלות שהתקבלו מ"${segmentLabel}":\n${list}\n\nלכל מוטיב שתמצא, ציין גם קטגוריה קצרה (למשל "בדיקת זכאות", "ביטול סמינר", "בקשה להירשם") וכמה הודעות מהרשימה תואמות אותו. מיין מהשכיח ביותר לפחות שכיח.\nהחזר אך ורק אובייקט JSON התואם לסכימה: ${schema}\nאם אין מוטיב חוזר משמעותי, החזר faqSuggestions: []`;
  return callGemini(apiKey, 'gemini-3.5-flash', systemInstruction, prompt, true);
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

/** Free-form Q&A grounded in a group's actual message transcript, with optional prior turns for follow-ups. */
export async function askGeminiAboutChat(apiKey, chatName, transcript, question, chatHistory = []) {
  const systemInstruction = `אתה עוזר שעונה על שאלות לגבי תוכן קבוצת וואטסאפ ספציפית.
קיבלת את התמליל המלא של קבוצת "${chatName}" (כל שורה היא "[תאריך] שולח: הודעה").
ענה על שאלת המשתמש בהתבסס אך ורק על מה שנכתב בפועל בתמליל.
אם המידע לא נמצא בתמליל, אמור זאת בכנות ("לא נמצא מידע על כך בשיחה") במקום לנחש.
ענה בעברית בלבד, בפורמט Markdown נקי (הדגשות, רשימות, טבלאות כשמתאים).`;

  const historyPrompt = chatHistory.length > 0
    ? `להלן היסטוריית השיחה איתך עד כה:\n${chatHistory.map(h => `${h.role === 'user' ? 'משתמש' : 'עוזר'}: ${h.text}`).join('\n')}\n\n`
    : '';

  const prompt = `תמליל מלא של קבוצת הוואטסאפ "${chatName}":\n"""\n${transcript}\n"""\n\n${historyPrompt}שאלת המשתמש:\n"${question}"\n\nענה בעברית, מבוסס אך ורק על התמליל שלמעלה.`;

  return callGemini(apiKey, 'gemini-3.5-flash', systemInstruction, prompt, false);
}

export async function transcribeVoiceMessage(apiKey, audioBase64, mimeType = 'audio/ogg') {
  const systemInstruction = 'אתה שירות תמלול קול לעברית מקצועי. תמלל את השמע בדיוק כפי שנאמר. אל תוסיף הערות, כותרות או תגובות — רק את הטקסט המתומלל עצמו.';
  const prompt = 'תמלל את ההודעה הקולית הזו בעברית.';
  const inlineDataParts = [{ inlineData: { mimeType, data: audioBase64 } }];
  return callGemini(apiKey, 'gemini-3.1-flash-lite', systemInstruction, prompt, false, inlineDataParts);
}

export async function ocrImage(apiKey, imageBase64, mimeType = 'image/jpeg') {
  const systemInstruction = 'אתה שירות OCR מתקדם לעברית ואנגלית. חלץ את כל הטקסט, התאריכים, הטבלאות והרשימות מהתמונה, ושמור על מבנה קרוב ככל האפשר למקור. החזר רק את הטקסט שחולץ.';
  const prompt = 'חלץ את כל הטקסט והפרטים הכתובים בתמונה הזו.';
  const inlineDataParts = [{ inlineData: { mimeType, data: imageBase64 } }];
  return callGemini(apiKey, 'gemini-3.1-flash-lite', systemInstruction, prompt, false, inlineDataParts);
}

/**
 * Live per-message triage: does the account owner need to do something in
 * response to this single incoming message? Runs on every message (group or
 * 1:1) when live listening is enabled. Errs toward "no" for small talk,
 * acknowledgements, and messages that are informational only.
 */
export async function analyzeMessageForAction(apiKey, { senderName, chatName, isGroup, text }) {
  const systemInstruction = `אתה עוזר שממיין הודעות וואטסאפ נכנסות עבור בעל החשבון, וקובע אם ההודעה דורשת ממנו לעשות משהו (לענות למישהו, לבצע משימה שהתבקש לבצע, לעמוד בדדליין, לקבל החלטה).
התעלם משיחת חולין, אישורי קבלה ("קיבלתי", "תודה", "👍"), עדכונים אינפורמטיביים בלבד, והודעות שלא דורשות פעולה מבעל החשבון באופן אישי.
אם אינך בטוח, החזר needsAction: false - עדיף לפספס מקרה גבולי מאשר להציף ברשימת המשימות.
אם needsAction הוא true, קבע גם קטגוריה קצרה שמאפיינת את סוג הבקשה - למשל "הצעת מחיר", "בדיקת זכאות", "מענה נדרש", "תיאום פגישה", "תשלום", "מסמך/אישור", או קטגוריה מתאימה אחרת בעברית.`;
  const schema = `{ "needsAction": true/false, "task": "תיאור קצר וברור של מה שצריך לעשות, בעברית, או null אם אין צורך בפעולה", "category": "קטגוריית הבקשה בעברית, או null", "deadline": "תאריך יעד בפורמט YYYY-MM-DD אם צוין במפורש, אחרת null" }`;
  const prompt = `הודעה שהתקבלה ${isGroup ? `בקבוצה "${chatName}"` : 'בצ׳אט אישי'} משולח בשם "${senderName}":
"${text}"

תאריך היום: ${new Date().toISOString().slice(0, 10)}.
החזר אך ורק אובייקט JSON התואם לסכימה: ${schema}`;
  return callGemini(apiKey, 'gemini-3.5-flash', systemInstruction, prompt, true);
}
