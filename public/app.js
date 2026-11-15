import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  updateProfile,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle("hidden", !on);

function showScreen(name) {
  const screens = { boot: "boot", auth: "auth-screen", verify: "verify-screen", app: "app-screen" };
  for (const [key, id] of Object.entries(screens)) show($(id), key === name);
}

let toastTimer;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 símbolos, sin O/0/I/1
function randomCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join(""); // 256 % 32 === 0: sin sesgo
}

const timeFmt = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long" });
const shortDateFmt = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit" });

function listTime(ms) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : shortDateFmt.format(d);
}

function authMessage(err) {
  switch (err && err.code) {
    case "auth/invalid-email": return "El email no es válido.";
    case "auth/email-already-in-use": return "Ya existe una cuenta con ese email.";
    case "auth/weak-password": return "La contraseña es muy débil (mínimo 6 caracteres).";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found": return "Email o contraseña incorrectos.";
    case "auth/too-many-requests": return "Demasiados intentos. Probá de nuevo en unos minutos.";
    case "auth/network-request-failed": return "Sin conexión. Revisá tu internet.";
    case "auth/operation-not-allowed": return "Activá Email/Contraseña en Firebase Authentication.";
    case "auth/unauthorized-continue-uri":
      return "Este dominio no está autorizado en Firebase (Authentication → Settings → Authorized domains).";
    default: return "No se pudo completar la acción. " + (err && err.message ? err.message : "");
  }
}

/* ------------------------------------------------------------------ */
/* Firebase                                                            */
/* ------------------------------------------------------------------ */
const configured =
  firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith("TU_");

let auth;
let db;
if (configured) {
  const fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  db = getFirestore(fbApp);
}

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */
let me = null; // { uid, displayName, friendCode }
let chats = []; // [{ id, otherUid, status, requester, blockedBy, lastMessage, lastMessageAt }]
let activeChatId = null;
let unsubChats = null;
let unsubMsgs = null;
let pinned = true; // true = el usuario está mirando el final de la conversación
let sessionId = 0; // se incrementa en cada cambio de sesión para descartar respuestas viejas
let verifyTimer = null;
let verifyTick = null;
let resendAt = 0;
const userCache = new Map(); // uid -> { displayName, friendCode }
const imageData = new Map(); // "chatId/imageId" -> data URL ya descargada
const imagePending = new Map(); // "chatId/imageId" -> Promise en curso

/* ------------------------------------------------------------------ */
/* Acceso (login / registro)                                           */
/* ------------------------------------------------------------------ */
let mode = "login";

function setMode(next) {
  mode = next;
  const register = mode === "register";
  show($("name-field"), register);
  $("auth-submit").textContent = register ? "Crear cuenta" : "Entrar";
  $("auth-toggle").textContent = register ? "¿Ya tenés cuenta? Entrá" : "¿No tenés cuenta? Registrate";
  $("auth-password").autocomplete = register ? "new-password" : "current-password";
  $("auth-error").textContent = "";
}

$("auth-toggle").addEventListener("click", () => setMode(mode === "login" ? "register" : "login"));

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("auth-error");
  errorEl.textContent = "";

  if (!configured) {
    errorEl.textContent = "Falta configurar Firebase: completá public/firebase-config.js (ver README).";
    return;
  }

  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const name = $("auth-name").value.trim();
  if (mode === "register" && !name) {
    errorEl.textContent = "Elegí un nombre para que te reconozcan.";
    return;
  }

  $("auth-submit").disabled = true;
  try {
    if (mode === "register") {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      // El nombre se guarda en la cuenta; el perfil público se crea recién cuando se verifique el email.
      try {
        await updateProfile(cred.user, { displayName: name });
      } catch {
        /* si falla, se usa la parte local del email como nombre */
      }
      try {
        await sendVerification(cred.user);
        resendAt = Date.now() + 60000;
        $("verify-error").textContent = "";
        $("verify-info").textContent = "Te enviamos el email de verificación.";
      } catch (err) {
        $("verify-info").textContent = "";
        $("verify-error").textContent = authMessage(err) + " Probá con «Reenviar email».";
      }
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (err) {
    errorEl.textContent = authMessage(err);
  } finally {
    $("auth-submit").disabled = false;
  }
});

$("logout").addEventListener("click", () => signOut(auth));
$("verify-logout").addEventListener("click", () => signOut(auth));

/* ------------------------------------------------------------------ */
/* Verificación de email                                               */
/* ------------------------------------------------------------------ */
async function sendVerification(user) {
  try {
    await sendEmailVerification(user, { url: window.location.origin });
  } catch (err) {
    // Si el dominio todavía no está autorizado, se manda el email igual, sin enlace de regreso.
    if (err && (err.code === "auth/unauthorized-continue-uri" || err.code === "auth/invalid-continue-uri")) {
      await sendEmailVerification(user);
    } else {
      throw err;
    }
  }
}

function stopVerifyPolling() {
  clearInterval(verifyTimer);
  verifyTimer = null;
  if (verifyTick) {
    window.removeEventListener("focus", verifyTick);
    document.removeEventListener("visibilitychange", verifyTick);
    verifyTick = null;
  }
}

// Consulta a Firebase si el email ya se verificó. Devuelve true si entró a la app.
async function checkVerified(user) {
  try {
    await user.reload();
  } catch {
    return false;
  }
  if (!user.emailVerified) return false;
  if (!verifyTick) return true; // otra comprobación simultánea ya entró a la app
  stopVerifyPolling();
  try {
    await user.getIdToken(true); // refresca el token para que incluya email_verified = true
  } catch {
    /* si falla, enterApp lo va a reportar */
  }
  await enterApp(user);
  return true;
}

function showVerify(user) {
  stopVerifyPolling();
  $("verify-email").textContent = user.email || "tu email";
  showScreen("verify");

  verifyTick = () => {
    if (document.visibilityState === "visible") checkVerified(user);
  };
  verifyTimer = setInterval(verifyTick, 5000);
  window.addEventListener("focus", verifyTick);
  document.addEventListener("visibilitychange", verifyTick);
}

$("verify-check").addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;
  $("verify-error").textContent = "";
  $("verify-info").textContent = "";
  const ok = await checkVerified(user);
  if (!ok) {
    $("verify-error").textContent = "Todavía no figura como verificado. Abrí el enlace del email y probá de nuevo.";
  }
});

$("verify-resend").addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;
  $("verify-error").textContent = "";
  $("verify-info").textContent = "";

  const wait = resendAt - Date.now();
  if (wait > 0) {
    $("verify-error").textContent = `Esperá ${Math.ceil(wait / 1000)} s antes de reenviar.`;
    return;
  }
  try {
    await sendVerification(user);
    resendAt = Date.now() + 60000;
    $("verify-info").textContent = "Te reenviamos el email.";
  } catch (err) {
    $("verify-error").textContent = authMessage(err);
  }
});

/* ------------------------------------------------------------------ */
/* Perfil + código de amistad                                          */
/* ------------------------------------------------------------------ */
async function createProfile(uid, displayName) {
  // Reserva un código único y crea el perfil en la misma transacción.
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    try {
      await runTransaction(db, async (tx) => {
        const codeRef = doc(db, "friendCodes", code);
        const taken = await tx.get(codeRef);
        if (taken.exists()) throw new Error("code-taken");
        tx.set(codeRef, { uid });
        tx.set(doc(db, "users", uid), { displayName, friendCode: code, createdAt: serverTimestamp() });
      });
      return { displayName, friendCode: code };
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "code-taken") throw err;
    }
  }
  throw new Error("No se pudo generar un código único. Probá de nuevo.");
}

async function loadOrCreateProfile(user) {
  const snap = await getDoc(doc(db, "users", user.uid));
  if (snap.exists()) return snap.data();
  const fallback = (user.email || "usuario").split("@")[0];
  const name = (user.displayName || fallback).trim().slice(0, 40) || "Usuario";
  return createProfile(user.uid, name);
}

async function loadUser(uid) {
  if (userCache.has(uid)) return userCache.get(uid);
  let profile = { displayName: "Usuario", friendCode: "" };
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) profile = snap.data();
    userCache.set(uid, profile);
  } catch {
    /* si falla, mostramos un nombre genérico sin cachearlo */
  }
  return profile;
}

$("me-code").addEventListener("click", async () => {
  if (!me) return;
  try {
    await navigator.clipboard.writeText(me.friendCode);
    toast("Código copiado");
  } catch {
    toast("Tu código: " + me.friendCode);
  }
});

/* ------------------------------------------------------------------ */
/* Sesión                                                              */
/* ------------------------------------------------------------------ */
function cleanup() {
  sessionId++;
  if (unsubChats) unsubChats();
  if (unsubMsgs) unsubMsgs();
  unsubChats = unsubMsgs = null;
  me = null;
  chats = [];
  activeChatId = null;
  pinned = true;
  userCache.clear();
  imageData.clear();
  imagePending.clear();
  imageObserver.disconnect();
  $("chat-list").replaceChildren();
  $("messages").replaceChildren();
  show($("chat-view"), false);
  show($("chat-placeholder"), true);
  show($("lightbox"), false);
  $("app-screen").classList.remove("in-chat");
}

async function enterApp(user) {
  const mySession = sessionId;
  let profile;
  try {
    profile = await loadOrCreateProfile(user);
  } catch (err) {
    if (mySession !== sessionId) return;
    $("auth-error").textContent = "No se pudo cargar tu perfil: " + (err.code || err.message);
    showScreen("auth");
    await signOut(auth);
    return;
  }
  if (mySession !== sessionId) return; // la sesión cambió mientras cargaba

  me = { uid: user.uid, displayName: profile.displayName, friendCode: profile.friendCode };
  $("auth-form").reset();
  $("verify-info").textContent = "";
  $("verify-error").textContent = "";
  setMode("login");
  $("me-name").textContent = me.displayName;
  $("me-code-text").textContent = me.friendCode;
  showScreen("app");
  startChatList();
}

if (configured) {
  onAuthStateChanged(auth, async (user) => {
    cleanup();
    stopVerifyPolling();

    if (!user) {
      showScreen("auth");
      return;
    }

    if (!user.emailVerified) {
      // Puede haberse verificado desde otro dispositivo: se consulta antes de pedirlo.
      try {
        await user.reload();
      } catch {
        /* sin conexión: se muestra la pantalla de verificación igual */
      }
      if (!user.emailVerified) {
        showVerify(user);
        return;
      }
      try {
        await user.getIdToken(true);
      } catch {
        /* enterApp lo va a reportar */
      }
    }
    await enterApp(user);
  });
} else {
  showScreen("auth");
  $("auth-error").textContent = "Falta configurar Firebase: completá public/firebase-config.js (ver README).";
}

/* ------------------------------------------------------------------ */
/* Estado de cada chat: abierto, pendiente o bloqueado                 */
/* ------------------------------------------------------------------ */
function chatState(c) {
  if (c.status === "blocked") return c.blockedBy === me.uid ? "blocked-by-me" : "blocked-by-them";
  if (c.status === "pending") return c.requester === me.uid ? "pending-out" : "pending-in";
  return "open";
}

function otherName(c) {
  return (userCache.get(c.otherUid) || { displayName: "Usuario" }).displayName;
}

/* ------------------------------------------------------------------ */
/* Lista de chats                                                      */
/* ------------------------------------------------------------------ */
function startChatList() {
  if (unsubChats) unsubChats();
  // Solo trae chats donde sos miembro; las reglas de Firestore lo exigen también en el servidor.
  const q = query(collection(db, "chats"), where("members", "array-contains", me.uid));
  unsubChats = onSnapshot(
    q,
    async (snap) => {
      if (!me) return;
      chats = snap.docs.map((d) => {
        const data = d.data({ serverTimestamps: "estimate" });
        return {
          id: d.id,
          otherUid: data.members.find((m) => m !== me.uid),
          status: data.status || "accepted", // chats viejos sin estado = aceptados
          requester: data.requester || null,
          blockedBy: data.blockedBy || null,
          lastMessage: data.lastMessage || "",
          lastMessageAt: data.lastMessageAt ? data.lastMessageAt.toMillis() : Date.now(),
        };
      });
      await Promise.all(chats.map((c) => loadUser(c.otherUid)));
      if (!me) return;
      renderChatList();
      applyChatState();
    },
    (err) => toast("No se pudieron cargar tus chats: " + (err.code || err.message))
  );
}

function previewFor(c, state) {
  if (state === "pending-in") return "Quiere chatear con vos";
  if (state === "pending-out") return "Solicitud enviada";
  if (state === "blocked-by-me") return "Contacto bloqueado";
  return c.lastMessage || "Sin mensajes todavía";
}

function renderChatList() {
  const list = $("chat-list");
  list.replaceChildren();

  const items = chats.map((c) => ({ c, state: chatState(c) }));
  // Las solicitudes por responder van primero; después, lo más reciente.
  items.sort((a, b) => {
    const ra = a.state === "pending-in" ? 0 : 1;
    const rb = b.state === "pending-in" ? 0 : 1;
    return ra - rb || b.c.lastMessageAt - a.c.lastMessageAt;
  });
  show($("chat-empty"), items.length === 0);

  for (const { c, state } of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-item" + (c.id === activeChatId ? " active" : "");

    const row = document.createElement("div");
    row.className = "row";

    const nameRow = document.createElement("div");
    nameRow.className = "name-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = otherName(c);
    nameRow.append(name);
    if (state === "pending-in" || state === "blocked-by-me") {
      const badge = document.createElement("span");
      badge.className = "badge" + (state === "blocked-by-me" ? " muted" : "");
      badge.textContent = state === "pending-in" ? "Solicitud" : "Bloqueado";
      nameRow.append(badge);
    }

    const time = document.createElement("time");
    time.textContent = state === "open" && c.lastMessage ? listTime(c.lastMessageAt) : "";
    row.append(nameRow, time);

    const preview = document.createElement("div");
    preview.className = "preview";
    preview.textContent = previewFor(c, state);

    btn.append(row, preview);
    btn.addEventListener("click", () => openChat(c.id));

    const li = document.createElement("li");
    li.append(btn);
    list.append(li);
  }
}

/* ------------------------------------------------------------------ */
/* Agregar contacto por código (crea una solicitud pendiente)          */
/* ------------------------------------------------------------------ */
$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("add-error");
  errorEl.textContent = "";
  const code = $("add-code").value.trim().toUpperCase();

  if (!/^[A-Z0-9]{8}$/.test(code)) {
    errorEl.textContent = "El código tiene 8 letras o números.";
    return;
  }
  if (code === me.friendCode) {
    errorEl.textContent = "Ese es tu propio código.";
    return;
  }

  const button = e.submitter || $("add-form").querySelector("button");
  button.disabled = true;
  try {
    const codeSnap = await getDoc(doc(db, "friendCodes", code));
    if (!codeSnap.exists()) {
      errorEl.textContent = "No existe ningún usuario con ese código.";
      return;
    }
    const otherUid = codeSnap.data().uid;
    const members = [me.uid, otherUid].sort();
    const chatId = members.join("_");
    const chatRef = doc(db, "chats", chatId);

    const existing = await getDoc(chatRef);
    if (!existing.exists()) {
      await setDoc(chatRef, {
        members,
        status: "pending",
        requester: me.uid,
        blockedBy: null,
        createdAt: serverTimestamp(),
        lastMessage: "",
        lastMessageAt: serverTimestamp(),
      });
      toast("Solicitud enviada. Podrán escribirse cuando la acepte.");
    }
    $("add-code").value = "";
    openChat(chatId);
  } catch (err) {
    errorEl.textContent = "No se pudo agregar: " + (err.code || err.message);
  } finally {
    button.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* Chat abierto                                                        */
/* ------------------------------------------------------------------ */
async function openChat(chatId) {
  if (unsubMsgs) unsubMsgs();
  unsubMsgs = null;
  if (activeChatId !== chatId) {
    imageData.clear();
    imagePending.clear();
  }
  activeChatId = chatId;
  pinned = true;

  const otherUid = chatId.split("_").find((p) => p !== me.uid);
  const other = await loadUser(otherUid);
  if (activeChatId !== chatId) return; // el usuario ya abrió otro chat

  $("chat-title").textContent = other.displayName;
  $("chat-subtitle").textContent = other.friendCode;
  $("messages").replaceChildren();
  show($("chat-placeholder"), false);
  show($("chat-view"), true);
  $("app-screen").classList.add("in-chat");
  renderChatList();
  applyChatState();

  // Últimos 300 mensajes; se piden en orden descendente y se invierten para mostrarlos.
  const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "desc"), limit(300));
  unsubMsgs = onSnapshot(
    q,
    (snap) => {
      if (activeChatId !== chatId) return;
      const msgs = snap.docs
        .map((d) => {
          const data = d.data({ serverTimestamps: "estimate" });
          return {
            id: d.id,
            senderId: data.senderId,
            text: data.text || "",
            imageId: data.imageId || null,
            at: data.createdAt.toMillis(),
          };
        })
        .reverse();
      renderMessages(chatId, msgs);
    },
    (err) => toast("No se pudieron cargar los mensajes: " + (err.code || err.message))
  );
}

// Muestra el banner correcto y habilita o bloquea el cuadro de mensajes según el estado del chat.
function applyChatState() {
  if (!activeChatId || !me) return;
  const c = chats.find((x) => x.id === activeChatId);
  const state = c ? chatState(c) : "loading";
  const name = c ? otherName(c) : "";

  const banners = {
    "pending-in": `${name} quiere chatear con vos. Hasta que aceptes, no pueden enviarse mensajes.`,
    "pending-out": `Esperando a que ${name} acepte tu solicitud. Podrás escribirle cuando lo haga.`,
    "blocked-by-me": `Bloqueaste a ${name}. No pueden escribirse hasta que lo desbloquees.`,
    "blocked-by-them": "No podés enviar mensajes en este chat.",
  };
  const text = banners[state];
  show($("chat-banner"), Boolean(text));
  $("banner-text").textContent = text || "";
  show($("banner-accept"), state === "pending-in");
  show($("banner-block"), state === "pending-in");
  show($("banner-unblock"), state === "blocked-by-me");
  show($("block-toggle"), state === "open");

  const canWrite = state === "open";
  $("send-text").disabled = !canWrite;
  $("send-btn").disabled = !canWrite;
  $("attach").disabled = !canWrite;
  $("send-text").placeholder = canWrite ? "Escribí un mensaje" : "No podés escribir en este chat";
}

async function chatAction(patch, okMessage) {
  if (!activeChatId) return;
  try {
    await updateDoc(doc(db, "chats", activeChatId), patch);
    if (okMessage) toast(okMessage);
  } catch (err) {
    toast("No se pudo completar la acción: " + (err.code || err.message));
  }
}

function confirmBlock() {
  const c = chats.find((x) => x.id === activeChatId);
  if (!c) return;
  const ok = window.confirm(
    `¿Bloquear a ${otherName(c)}? No van a poder enviarse mensajes. Podés desbloquearlo cuando quieras.`
  );
  if (ok) chatAction({ status: "blocked", blockedBy: me.uid }, "Contacto bloqueado");
}

$("banner-accept").addEventListener("click", () => chatAction({ status: "accepted" }, "Solicitud aceptada"));
$("banner-block").addEventListener("click", confirmBlock);
$("block-toggle").addEventListener("click", confirmBlock);
$("banner-unblock").addEventListener("click", () =>
  chatAction({ status: "accepted", blockedBy: null }, "Contacto desbloqueado")
);

/* ------------------------------------------------------------------ */
/* Mensajes                                                            */
/* ------------------------------------------------------------------ */
const messagesBox = $("messages");
messagesBox.addEventListener("scroll", () => {
  pinned = messagesBox.scrollHeight - messagesBox.scrollTop - messagesBox.clientHeight < 80;
});

function scrollToBottom() {
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

function renderMessages(chatId, msgs) {
  const box = messagesBox;
  const prevTop = box.scrollTop;
  const wasPinned = pinned;
  imageObserver.disconnect();
  box.replaceChildren();

  let lastDay = "";
  for (const m of msgs) {
    const date = new Date(m.at);
    const day = date.toDateString();
    if (day !== lastDay) {
      const sep = document.createElement("div");
      sep.className = "day";
      sep.textContent = dayFmt.format(date);
      box.append(sep);
      lastDay = day;
    }

    const bubble = document.createElement("div");
    bubble.className = "msg" + (m.senderId === me.uid ? " mine" : "") + (m.imageId ? " has-image" : "");

    if (m.imageId) bubble.append(buildImage(chatId, m.imageId));
    if (m.text) {
      const text = document.createElement("span");
      text.textContent = m.text;
      bubble.append(text);
    }
    const time = document.createElement("time");
    time.textContent = timeFmt.format(date);
    bubble.append(time);
    box.append(bubble);
  }

  // Si estabas leyendo mensajes viejos, no te mueve; si estabas al final, te deja al final.
  box.scrollTop = wasPinned ? box.scrollHeight : prevTop;
}

async function sendMessage(text) {
  const chatRef = doc(db, "chats", activeChatId);
  const msgRef = doc(collection(chatRef, "messages"));
  const batch = writeBatch(db);
  batch.set(msgRef, { senderId: me.uid, text, createdAt: serverTimestamp() });
  batch.update(chatRef, { lastMessage: text.slice(0, 120), lastMessageAt: serverTimestamp() });
  await batch.commit();
}

$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("send-text");
  const text = input.value.trim();
  if (!text || !activeChatId) return;

  input.value = "";
  pinned = true;
  try {
    await sendMessage(text);
  } catch (err) {
    input.value = text;
    toast("No se pudo enviar: " + (err.code || err.message));
  }
});

$("back").addEventListener("click", () => {
  $("app-screen").classList.remove("in-chat");
  if (unsubMsgs) unsubMsgs();
  unsubMsgs = null;
  activeChatId = null;
  show($("chat-view"), false);
  show($("chat-placeholder"), true);
  renderChatList();
});

/* ------------------------------------------------------------------ */
/* Imágenes                                                            */
/* ------------------------------------------------------------------ */
// Se guardan en Firestore como JPEG comprimido en base64 (el límite de un documento es 1 MiB),
// así funciona en el plan gratuito sin necesitar Cloud Storage.
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_INPUT_BYTES = 10 * 1024 * 1024; // lo que se acepta elegir (se comprime antes de subir)
const MAX_DATA_CHARS = 700000; // tope del base64 resultante (las reglas permiten hasta 750000)

async function decodeImage(file) {
  if ("createImageBitmap" in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* cae al método clásico */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Reduce tamaño y calidad hasta que el JPEG entre en el límite. Devuelve el base64 sin el prefijo.
async function compressImage(file) {
  const img = await decodeImage(file);
  try {
    let maxSide = 1280;
    let quality = 0.82;
    for (let i = 0; i < 8; i++) {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; // los PNG con transparencia quedan sobre blanco
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (base64.length > 0 && base64.length <= MAX_DATA_CHARS) return base64;

      quality = Math.max(0.5, quality - 0.1);
      maxSide = Math.round(maxSide * 0.8);
    }
  } finally {
    img.close();
  }
  throw new Error("too-big");
}

async function sendImage(chatId, base64) {
  const chatRef = doc(db, "chats", chatId);
  const imgRef = doc(collection(chatRef, "images"));
  const msgRef = doc(collection(chatRef, "messages"));

  // Se guarda en memoria para que a quien la envía no se le vuelva a descargar.
  imageData.set(`${chatId}/${imgRef.id}`, "data:image/jpeg;base64," + base64);

  const batch = writeBatch(db);
  batch.set(imgRef, { senderId: me.uid, mime: "image/jpeg", data: base64, createdAt: serverTimestamp() });
  batch.set(msgRef, { senderId: me.uid, text: "", imageId: imgRef.id, createdAt: serverTimestamp() });
  batch.update(chatRef, { lastMessage: "📷 Imagen", lastMessageAt: serverTimestamp() });
  await batch.commit();
}

$("attach").addEventListener("click", () => $("file-input").click());

$("file-input").addEventListener("change", async () => {
  const input = $("file-input");
  const file = input.files && input.files[0];
  input.value = "";
  const chatId = activeChatId;
  if (!file || !chatId) return;

  if (!ALLOWED_TYPES.includes(file.type)) {
    toast("Formato no soportado. Usá JPG, PNG, WebP o GIF.");
    return;
  }
  if (file.size > MAX_INPUT_BYTES) {
    toast("La imagen supera los 10 MB.");
    return;
  }

  $("attach").disabled = true;
  $("send-btn").disabled = true;
  toast("Enviando imagen…");
  try {
    const base64 = await compressImage(file);
    pinned = true;
    await sendImage(chatId, base64);
  } catch (err) {
    toast(
      err && err.message === "too-big"
        ? "No se pudo reducir la imagen lo suficiente. Probá con otra."
        : "No se pudo enviar la imagen: " + ((err && (err.code || err.message)) || "error")
    );
  } finally {
    applyChatState();
  }
});

function loadImage(chatId, imageId) {
  const key = `${chatId}/${imageId}`;
  if (imageData.has(key)) return Promise.resolve(imageData.get(key));
  if (!imagePending.has(key)) {
    const p = getDoc(doc(db, "chats", chatId, "images", imageId))
      .then((snap) => {
        if (!snap.exists()) throw new Error("missing");
        const src = "data:image/jpeg;base64," + snap.data().data;
        imageData.set(key, src);
        return src;
      })
      .finally(() => imagePending.delete(key));
    imagePending.set(key, p);
  }
  return imagePending.get(key);
}

// Las imágenes se descargan recién cuando están por aparecer en pantalla.
const imageObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      imageObserver.unobserve(entry.target);
      if (typeof entry.target._load === "function") entry.target._load();
    }
  },
  { rootMargin: "300px" }
);

function buildImage(chatId, imageId) {
  const wrap = document.createElement("div");
  wrap.className = "msg-img";
  const img = document.createElement("img");
  img.alt = "Imagen enviada";
  wrap.append(img);

  const apply = (src) => {
    img.addEventListener("load", () => {
      if (pinned && wrap.isConnected) scrollToBottom();
    }, { once: true });
    img.addEventListener("click", () => openLightbox(src));
    img.src = src;
    wrap.classList.add("loaded");
  };

  const cached = imageData.get(`${chatId}/${imageId}`);
  if (cached) {
    apply(cached);
  } else {
    wrap._load = () => {
      loadImage(chatId, imageId)
        .then((src) => {
          if (wrap.isConnected) apply(src);
        })
        .catch(() => {
          wrap.classList.add("failed");
          wrap.textContent = "No se pudo cargar la imagen";
        });
    };
    imageObserver.observe(wrap);
  }
  return wrap;
}

function closeLightbox() {
  show($("lightbox"), false);
  $("lightbox-img").removeAttribute("src");
}
function openLightbox(src) {
  $("lightbox-img").src = src;
  show($("lightbox"), true);
}
$("lightbox").addEventListener("click", closeLightbox);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("lightbox").classList.contains("hidden")) closeLightbox();
});
