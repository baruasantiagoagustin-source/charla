# Charla — chat privado con Firebase

App web de mensajería privada. Al registrarte recibís un **código de amistad** de 8 caracteres
(es tu ID público). Con el código de otra persona le mandás una solicitud; cuando la acepta, pueden
chatear. Nadie más puede ver esa conversación.

## Qué incluye

- **Verificación de email real:** al registrarte, Firebase manda un enlace de verificación. Hasta que lo abras,
  no podés usar la app, y las reglas de Firestore rechazan cualquier operación de cuentas sin verificar.
- **Aceptar o bloquear:** agregar a alguien por código crea una solicitud *pendiente*. Quien la recibe puede
  **aceptar** o **bloquear**. Hasta que se acepte no se pueden enviar mensajes. Se puede bloquear en cualquier
  momento y solo quien bloqueó puede desbloquear.
- **Imágenes:** JPG, PNG, WebP o GIF de hasta 10 MB. Se comprimen en el navegador a JPEG (máx. 1280 px,
  ~700 KB) y se guardan en Firestore, así funciona en el plan gratuito. Los GIF animados se envían como imagen fija.
- **Tiempo real**, diseño responsive y modo oscuro.

## Estructura del proyecto

```
charla/
├── public/               ← el sitio (lo que se publica)
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── firebase-config.js   ← acá pegás la config de tu proyecto Firebase
├── firestore.rules       ← reglas de seguridad (se suben con Firebase CLI, NO con Vercel)
├── tests/                ← pruebas de las reglas (no se publican)
├── firebase.json
├── vercel.json
└── README.md
```

## Estructura de Firestore

| Ruta | Contenido |
|---|---|
| `users/{uid}` | `displayName`, `friendCode` (perfil público) |
| `friendCodes/{code}` | `uid` (índice para buscar por código y asegurar unicidad) |
| `chats/{uidA_uidB}` | `members`, `status` (`pending` / `accepted` / `blocked`), `requester`, `blockedBy`, `lastMessage`, `lastMessageAt` |
| `chats/{chatId}/messages/{id}` | `senderId`, `text`, `imageId` (si es imagen), `createdAt` |
| `chats/{chatId}/images/{id}` | `senderId`, `mime`, `data` (JPEG en base64), `createdAt` |

Los chats creados con la versión anterior no tienen `status`: se tratan como aceptados y siguen funcionando.

## Qué garantizan las reglas

- Solo cuentas con email verificado pueden leer o escribir algo.
- Solo los dos miembros de un chat pueden leerlo, y leer o escribir sus mensajes e imágenes.
- Solo se puede escribir si el chat está aceptado. Solo quien **recibió** la solicitud puede aceptarla.
- Solo quien bloqueó puede desbloquear.
- No se puede listar usuarios ni códigos: solo consultar uno si ya conocés el código exacto.
- Los mensajes no se editan ni se borran; `senderId` tiene que ser el usuario autenticado.
- El código de amistad no se puede modificar y cada usuario reserva uno solo.
- Las imágenes tienen un tope de tamaño en el servidor, no solo en la interfaz.

---

## 1. Configurar Firebase

1. **Proyecto:** <https://console.firebase.google.com> → *Agregar proyecto* (o usá el que ya tenías).
2. **Authentication:** *Build → Authentication → Comenzar → Email/contraseña → Habilitar*.
   (No hace falta activar "Vínculo de correo electrónico (acceso sin contraseña)".)
3. **Firestore:** *Build → Firestore Database → Crear base de datos*.
4. **App web:** *Configuración del proyecto → Tus apps → `</>` Web*. Copiá el objeto `firebaseConfig`
   y pegalo en `public/firebase-config.js`.
5. **Subir las reglas** (hay que repetirlo cada vez que cambie `firestore.rules`, incluida esta actualización):
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add        # elegí tu proyecto
   firebase deploy --only firestore:rules
   ```
6. **Personalizar el email de verificación (recomendado):**
   *Authentication → Templates → Verificación de la dirección de correo electrónico*. Podés cambiar el idioma a
   español, el nombre del remitente y el asunto. El mensaje sale por defecto desde
   `noreply@TU_PROYECTO.firebaseapp.com`, y a veces cae en spam: si pasa, es normal y se resuelve configurando un
   dominio propio o un SMTP personalizado en esa misma pantalla.

## 2. Probar en local

Los módulos ES no funcionan abriendo el archivo con doble clic:

```bash
npx serve public
```

Abrí la URL que muestra (normalmente <http://localhost:3000>). `localhost` ya está autorizado en Firebase Auth.

### Checklist de prueba (necesitás dos emails reales)

1. Registrá la cuenta A. Debe aparecer la pantalla *Verificá tu email* y llegar el correo.
2. Abrí el enlace del correo. La pantalla de la app debe pasar sola a la app (puede tardar unos segundos).
3. Registrá y verificá la cuenta B (en una ventana de incógnito).
4. Con A: pegá el código de B y tocá *Agregar*. A ve "Esperando a que B acepte…" y no puede escribir.
5. Con B: aparece el chat con la insignia *Solicitud*. *Aceptar* → ya pueden escribirse.
6. Probá enviar una imagen con 📎 y tocarla para verla ampliada.
7. Con B: *Bloquear* → A ya no puede enviar. *Desbloquear* → vuelve a funcionar.

### Pruebas automáticas de las reglas (recomendado antes de publicar)

La carpeta `tests/` trae ~50 pruebas de las reglas de seguridad (verificación, solicitudes, bloqueo, privacidad
entre usuarios, imágenes). Necesitan Node y Java (el emulador de Firestore corre sobre Java):

```bash
cd tests
npm install
npm test
```

Si alguna prueba falla, puede ser un error de la regla o de la prueba: pegá la salida y se revisa.

> Las cuentas de prueba que creaste antes de esta versión no están verificadas. Para usarlas tienen que tener un
> email real al que les llegue el enlace; si usaste emails inventados, creá cuentas nuevas.

---

## 3. Publicar en Vercel (paso a paso)

El sitio es estático (sin build), así que Vercel solo tiene que servir la carpeta `public/`. Vercel **no** sube las
reglas de Firestore: esas se suben con el Firebase CLI (paso 5 de arriba).

> Nota: estos pasos siguen el flujo habitual de Vercel. Si algún nombre de botón cambió, buscá el equivalente en
> su documentación: <https://vercel.com/docs>.

### Opción A — desde GitHub (recomendada: cada `git push` publica solo)

1. **Subí el proyecto a GitHub.** Desde la carpeta `charla/`:
   ```bash
   git init
   git add .
   git commit -m "Charla"
   git branch -M main
   # creá un repositorio vacío en github.com y copiá su URL:
   git remote add origin https://github.com/TU_USUARIO/charla.git
   git push -u origin main
   ```
   `public/firebase-config.js` va al repositorio y está bien: esa configuración no es secreta (la seguridad la
   dan las reglas de Firestore).
2. **Entrá a <https://vercel.com>** e iniciá sesión con tu cuenta de GitHub.
3. **Add New… → Project** y elegí el repositorio `charla` (*Import*).
4. En la pantalla de configuración:
   - **Framework Preset:** `Other`
   - **Root Directory:** `./` (la raíz)
   - **Build Command:** dejalo vacío
   - **Output Directory:** `public` (ya lo define `vercel.json`; verificá que figure así)
   - **Install Command:** vacío
5. **Deploy.** En un minuto tenés una URL del estilo `https://charla-xxxx.vercel.app`. Copiala.
6. **Autorizá el dominio en Firebase** (sin esto, el enlace de verificación no puede traer de vuelta a la app):
   *Firebase Console → Authentication → Settings → Authorized domains → Add domain* y pegá
   `charla-xxxx.vercel.app` (sin `https://`).
7. **Asegurate de haber subido las reglas** nuevas: `firebase deploy --only firestore:rules`.
8. **Probá en la URL de Vercel** con el checklist de arriba.

### Opción B — con la terminal (sin GitHub)

```bash
npm install -g vercel
vercel login
vercel            # primera vez: respondé las preguntas; Output Directory = public
vercel --prod     # publica en producción
```

Después seguí con los pasos 6 y 7 de la opción A.

### Después de publicar

- **Actualizar:** con GitHub, cada `git push` a `main` publica una versión nueva. Con la terminal, `vercel --prod`.
- **Dominio propio:** *Vercel → tu proyecto → Settings → Domains*. Después agregalo también en
  *Firebase → Authentication → Settings → Authorized domains*.
- **Preview deployments:** las ramas y pull requests reciben URLs temporales distintas. Esas URLs no están
  autorizadas en Firebase; el registro y el login funcionan igual, pero el enlace del mail no vuelve a esa URL
  (la app igual detecta la verificación sola).
- **Plan:** según los términos de Vercel, el plan gratuito (Hobby) es para uso personal y no comercial. Revisalo
  si el proyecto es comercial.
- **Restringir la API key (opcional, recomendado):** en Google Cloud Console → *APIs y servicios → Credenciales* →
  la clave "Browser key" de tu proyecto → *Restricciones de aplicaciones → Sitios web* y agregá tus dominios
  (`localhost`, tu dominio de Vercel y `TU_PROYECTO.firebaseapp.com`). Si algo deja de funcionar, revisá esa lista.

---

## Límites conocidos

- **Anti-bots:** la verificación de email frena los registros automáticos más simples, pero no a alguien con
  muchos emails reales. El siguiente paso serio es **Firebase App Check** (reCAPTCHA) y limitar la cantidad de
  mensajes por usuario.
- **Imágenes en Firestore:** cada imagen descargada cuenta como una lectura y puede pesar hasta ~700 KB de transferencia, y se vuelve
  a descargar al recargar la página. Sirve bien para uso personal o grupos chicos; para mucho tráfico conviene
  Cloud Storage for Firebase, que desde 2024 exige el plan de pago Blaze para crear un bucket nuevo.
- Los mensajes no están cifrados de extremo a extremo: Google/Firebase puede técnicamente leerlos.
- Cualquiera que conozca tu código puede mandarte una solicitud (no podrá escribirte hasta que aceptes, y podés bloquearlo).
- Sin notificaciones push, estados de lectura ni recuperación de contraseña en la interfaz
  (Firebase Auth la soporta con `sendPasswordResetEmail`).
#   c h a r l a  
 #   c h a r l a  
 