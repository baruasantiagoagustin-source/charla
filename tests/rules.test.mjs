import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, writeBatch,
  collection, query, where, serverTimestamp,
} from "firebase/firestore";

const RULES = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const env = await initializeTestEnvironment({
  projectId: "demo-charla",
  firestore: { rules: RULES, host: "127.0.0.1", port: 8080 },
});

let passed = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ok  ", name); }
  catch (e) { failures.push(name); console.log("  FAIL", name, "-", String(e.message).split("\n")[0]); }
}

const verified = (uid) => env.authenticatedContext(uid, { email_verified: true, email: uid + "@x.com" }).firestore();
const unverified = (uid) => env.authenticatedContext(uid, { email_verified: false, email: uid + "@x.com" }).firestore();
const chatIdOf = (a, b) => [a, b].sort().join("_");

async function reset() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    for (const [uid, code] of [["alice", "AAAAAAAA"], ["bob", "BBBBBBBB"], ["carol", "CCCCCCCC"]]) {
      await setDoc(doc(d, "users", uid), { displayName: uid, friendCode: code });
      await setDoc(doc(d, "friendCodes", code), { uid });
    }
  });
}
async function seedChat(id, data) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "chats", id), data);
  });
}
const newChat = (requester, other) => ({
  members: [requester, other].sort(), status: "pending", requester, blockedBy: null,
  createdAt: serverTimestamp(), lastMessage: "", lastMessageAt: serverTimestamp(),
});
const sendText = async (db, chatId, uid, text = "hola") => {
  const b = writeBatch(db);
  b.set(doc(collection(db, "chats", chatId, "messages")), { senderId: uid, text, createdAt: serverTimestamp() });
  b.update(doc(db, "chats", chatId), { lastMessage: text, lastMessageAt: serverTimestamp() });
  return b.commit();
};
const sendImage = async (db, chatId, uid, data = "QUJD") => {
  const chatRef = doc(db, "chats", chatId);
  const imgRef = doc(collection(chatRef, "images"));
  const b = writeBatch(db);
  b.set(imgRef, { senderId: uid, mime: "image/jpeg", data, createdAt: serverTimestamp() });
  b.set(doc(collection(chatRef, "messages")), { senderId: uid, text: "", imageId: imgRef.id, createdAt: serverTimestamp() });
  b.update(chatRef, { lastMessage: "📷 Imagen", lastMessageAt: serverTimestamp() });
  return b.commit();
};

const AB = chatIdOf("alice", "bob");

console.log("Email verificado");
await reset();
await t("sin verificar no puede leer perfiles", () => assertFails(getDoc(doc(unverified("eve"), "users", "alice"))));
await t("verificado puede leer un perfil puntual", () => assertSucceeds(getDoc(doc(verified("alice"), "users", "bob"))));
await t("nadie puede listar usuarios", () => assertFails(getDocs(collection(verified("alice"), "users"))));
await t("sin verificar no puede crear chat", () => assertFails(setDoc(doc(unverified("alice"), "chats", AB), newChat("alice", "bob"))));

console.log("Registro (código de amistad)");
await reset();
await t("usuario nuevo reserva código y crea perfil en un batch", async () => {
  const d = verified("dave");
  const b = writeBatch(d);
  b.set(doc(d, "friendCodes", "DDDDDDDD"), { uid: "dave" });
  b.set(doc(d, "users", "dave"), { displayName: "dave", friendCode: "DDDDDDDD", createdAt: serverTimestamp() });
  await assertSucceeds(b.commit());
});
await t("no puede quedarse con un código a nombre de otro", async () => {
  const d = verified("erin");
  const b = writeBatch(d);
  b.set(doc(d, "friendCodes", "EEEEEEEE"), { uid: "alice" });
  await assertFails(b.commit());
});
await t("no puede reservar un segundo código si ya tiene perfil", () =>
  assertFails(setDoc(doc(verified("alice"), "friendCodes", "ZZZZZZZZ"), { uid: "alice" })));
await t("no puede cambiar su friendCode", () =>
  assertFails(updateDoc(doc(verified("alice"), "users", "alice"), { friendCode: "ZZZZZZZZ" })));
await t("sí puede cambiar su nombre", () =>
  assertSucceeds(updateDoc(doc(verified("alice"), "users", "alice"), { displayName: "Ali" })));

console.log("Solicitud pendiente");
await reset();
await t("crear solicitud pending a nombre propio", () => assertSucceeds(setDoc(doc(verified("alice"), "chats", AB), newChat("alice", "bob"))));
await reset();
await t("no puede crear chat ya 'accepted'", () =>
  assertFails(setDoc(doc(verified("alice"), "chats", AB), { ...newChat("alice", "bob"), status: "accepted" })));
await t("no puede crear solicitud haciéndose pasar por otro requester", () =>
  assertFails(setDoc(doc(verified("alice"), "chats", AB), { ...newChat("alice", "bob"), requester: "bob" })));
await t("no puede crear chat con un usuario que no existe", () =>
  assertFails(setDoc(doc(verified("alice"), "chats", chatIdOf("alice", "ghost")), newChat("alice", "ghost"))));
await t("un tercero no puede crear el chat entre otros dos", () =>
  assertFails(setDoc(doc(verified("carol"), "chats", AB), newChat("alice", "bob"))));
await seedChat(AB, { members: ["alice", "bob"], status: "pending", requester: "alice", blockedBy: null, lastMessage: "", lastMessageAt: new Date() });
await t("nadie escribe mensajes mientras está pendiente", () => assertFails(sendText(verified("alice"), AB, "alice")));
await t("el que envió la solicitud no puede aceptarla", () => assertFails(updateDoc(doc(verified("alice"), "chats", AB), { status: "accepted" })));
await t("un tercero no puede aceptar", () => assertFails(updateDoc(doc(verified("carol"), "chats", AB), { status: "accepted" })));
await t("el destinatario puede aceptar", () => assertSucceeds(updateDoc(doc(verified("bob"), "chats", AB), { status: "accepted" })));

console.log("Chat aceptado");
await reset();
await seedChat(AB, { members: ["alice", "bob"], status: "accepted", requester: "alice", blockedBy: null, lastMessage: "", lastMessageAt: new Date() });
await t("alice envía texto", () => assertSucceeds(sendText(verified("alice"), AB, "alice")));
await t("bob envía texto", () => assertSucceeds(sendText(verified("bob"), AB, "bob")));
await t("no puede enviar con senderId ajeno", () => assertFails(sendText(verified("alice"), AB, "bob")));
await t("no puede enviar texto vacío", () => assertFails(sendText(verified("alice"), AB, "alice", "")));
await t("no puede enviar texto de más de 2000 caracteres", () => assertFails(sendText(verified("alice"), AB, "alice", "x".repeat(2001))));
await t("no puede falsear createdAt", () =>
  assertFails(setDoc(doc(collection(verified("alice"), "chats", AB, "messages")), { senderId: "alice", text: "x", createdAt: new Date(0) })));
await t("carol no puede escribir en el chat ajeno", () => assertFails(sendText(verified("carol"), AB, "carol")));
await t("carol no puede leer los mensajes", () => assertFails(getDocs(collection(verified("carol"), "chats", AB, "messages"))));
await t("carol no puede leer el documento del chat", () => assertFails(getDoc(doc(verified("carol"), "chats", AB))));
await t("carol ve 0 chats con su propia consulta", async () => {
  const snap = await assertSucceeds(getDocs(query(collection(verified("carol"), "chats"), where("members", "array-contains", "carol"))));
  if (snap.size !== 0) throw new Error("vio " + snap.size);
});
await t("carol no puede consultar los chats de alice", () =>
  assertFails(getDocs(query(collection(verified("carol"), "chats"), where("members", "array-contains", "alice")))));
await t("alice ve su chat con su propia consulta", async () => {
  const snap = await assertSucceeds(getDocs(query(collection(verified("alice"), "chats"), where("members", "array-contains", "alice"))));
  if (snap.size !== 1) throw new Error("vio " + snap.size);
});
await t("alice lee mensajes de su chat", () => assertSucceeds(getDocs(collection(verified("alice"), "chats", AB, "messages"))));
await t("los mensajes no se editan", async () => {
  const snap = await getDocs(collection(verified("alice"), "chats", AB, "messages"));
  await assertFails(updateDoc(snap.docs[0].ref, { text: "editado" }));
});
await t("los mensajes no se borran", async () => {
  const snap = await getDocs(collection(verified("alice"), "chats", AB, "messages"));
  await assertFails(deleteDoc(snap.docs[0].ref));
});
await t("no se puede cambiar la lista de miembros", () => assertFails(updateDoc(doc(verified("alice"), "chats", AB), { members: ["alice", "carol"] })));
await t("no se puede borrar el chat", () => assertFails(deleteDoc(doc(verified("alice"), "chats", AB))));

console.log("Imágenes");
await t("alice envía una imagen", () => assertSucceeds(sendImage(verified("alice"), AB, "alice")));
await t("imagen demasiado grande (>750000) rechazada", () => assertFails(sendImage(verified("alice"), AB, "alice", "A".repeat(750001))));
await t("imagen de 700000 caracteres aceptada", () => assertSucceeds(sendImage(verified("alice"), AB, "alice", "A".repeat(700000))));
await t("bob puede leer la imagen", async () => {
  const snap = await getDocs(collection(verified("alice"), "chats", AB, "images"));
  await assertSucceeds(getDoc(doc(verified("bob"), "chats", AB, "images", snap.docs[0].id)));
});
await t("carol no puede leer la imagen", async () => {
  const snap = await getDocs(collection(verified("alice"), "chats", AB, "images"));
  await assertFails(getDoc(doc(verified("carol"), "chats", AB, "images", snap.docs[0].id)));
});
await t("no se puede subir imagen con otro mime", () =>
  assertFails(setDoc(doc(collection(verified("alice"), "chats", AB, "images")), { senderId: "alice", mime: "image/svg+xml", data: "QUJD", createdAt: serverTimestamp() })));

console.log("Bloqueo");
await reset();
await seedChat(AB, { members: ["alice", "bob"], status: "accepted", requester: "alice", blockedBy: null, lastMessage: "", lastMessageAt: new Date() });
await t("bob bloquea a alice", () => assertSucceeds(updateDoc(doc(verified("bob"), "chats", AB), { status: "blocked", blockedBy: "bob" })));
await t("no puede bloquear a nombre del otro", async () => {
  await seedChat(AB, { members: ["alice", "bob"], status: "accepted", requester: "alice", blockedBy: null, lastMessage: "", lastMessageAt: new Date() });
  await assertFails(updateDoc(doc(verified("bob"), "chats", AB), { status: "blocked", blockedBy: "alice" }));
  await updateDoc(doc(verified("bob"), "chats", AB), { status: "blocked", blockedBy: "bob" });
});
await t("alice no puede enviar mensajes bloqueada", () => assertFails(sendText(verified("alice"), AB, "alice")));
await t("alice no puede enviar imágenes bloqueada", () => assertFails(sendImage(verified("alice"), AB, "alice")));
await t("bob tampoco puede enviar mientras bloquea", () => assertFails(sendText(verified("bob"), AB, "bob")));
await t("alice sigue leyendo el historial", () => assertSucceeds(getDocs(collection(verified("alice"), "chats", AB, "messages"))));
await t("alice no puede desbloquearse", () => assertFails(updateDoc(doc(verified("alice"), "chats", AB), { status: "accepted", blockedBy: null })));
await t("alice no puede saltarse el bloqueo cambiando solo el status", () => assertFails(updateDoc(doc(verified("alice"), "chats", AB), { status: "accepted" })));
await t("bob desbloquea", () => assertSucceeds(updateDoc(doc(verified("bob"), "chats", AB), { status: "accepted", blockedBy: null })));
await t("alice vuelve a poder enviar", () => assertSucceeds(sendText(verified("alice"), AB, "alice")));
await t("solicitud pendiente: el destinatario puede bloquear", async () => {
  await seedChat(AB, { members: ["alice", "bob"], status: "pending", requester: "alice", blockedBy: null, lastMessage: "", lastMessageAt: new Date() });
  await assertSucceeds(updateDoc(doc(verified("bob"), "chats", AB), { status: "blocked", blockedBy: "bob" }));
});

console.log("Chats viejos (sin status)");
await reset();
await seedChat(AB, { members: ["alice", "bob"], lastMessage: "", lastMessageAt: new Date() });
await t("siguen funcionando para enviar mensajes", () => assertSucceeds(sendText(verified("alice"), AB, "alice")));
await t("se pueden bloquear", () => assertSucceeds(updateDoc(doc(verified("bob"), "chats", AB), { status: "blocked", blockedBy: "bob" })));

await env.cleanup();
console.log(`\n${passed} pruebas OK, ${failures.length} fallidas`);
if (failures.length) { console.log("Fallidas:\n- " + failures.join("\n- ")); process.exit(1); }
