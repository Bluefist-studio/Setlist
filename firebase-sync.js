const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCBICZaQbWoe202vZd9rGjZ1gzb3gafoLg',
  authDomain: 'setlist-d744d.firebaseapp.com',
  projectId: 'setlist-d744d',
  storageBucket: 'setlist-d744d.firebasestorage.app',
  messagingSenderId: '336182779858',
  appId: '1:336182779858:web:2c69869a460de5805ab20b'
};
const SDK_VERSION = '11.10.0';
let firebaseSdkPromise;

function loadFirebaseSdk() {
  if (!firebaseSdkPromise) {
    const base = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
    firebaseSdkPromise = Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-firestore.js`)
    ]);
  }
  return firebaseSdkPromise;
}

export function createFirebaseSync({ getLocalData, getEmptyData, hasLocalData, onRemoteData, onStatus, onAccount }) {
  let app;
  let auth;
  let database;
  let bootstrapped = false;
  let rulesVerified = false;
  let activeUserId = null;
  let preferRemoteNextBootstrap = false;
  let connecting = false;
  let writing = false;
  let writeQueued = false;
  let writeTimer;
  let stopListening;

  const setStatus = message => onStatus(message);

  async function ensureConnection() {
    if (!navigator.onLine) {
      setStatus('Offline · saved on this device');
      return false;
    }
    if (connecting) return false;
    connecting = true;
    setStatus('Connecting to Firebase…');
    try {
      const [appSdk, authSdk, firestoreSdk] = await loadFirebaseSdk();
      app = app || (appSdk.getApps().length ? appSdk.getApp() : appSdk.initializeApp(FIREBASE_CONFIG));
      auth = auth || authSdk.getAuth(app);
      database = database || firestoreSdk.getFirestore(app);
      if (!auth.currentUser) {
        onAccount?.({ uid: null, email: null, isAnonymous: false });
        setStatus('Local data ready · create an account or log in to sync');
        return false;
      }

      const userId = auth.currentUser.uid;
      onAccount?.({ uid: userId, email: auth.currentUser.email || null, isAnonymous: auth.currentUser.isAnonymous });
      if (activeUserId !== userId) {
        stopListening?.(); stopListening = null; bootstrapped = false;
        if (activeUserId !== null) writeQueued = false;
        activeUserId = userId;
      }
      if (!rulesVerified) {
        try {
          await firestoreSdk.getDoc(firestoreSdk.doc(database, 'users', '_setlist_rules_probe_', 'setlist', 'probe'));
          setStatus('Local only · publish private Firestore rules');
          return false;
        } catch (error) {
          if (error.code !== 'permission-denied') throw error;
          rulesVerified = true;
        }
      }
      const stateRef = firestoreSdk.doc(database, 'users', userId, 'setlist', 'current');
      if (!bootstrapped) {
        const remoteSnapshot = await firestoreSdk.getDoc(stateRef);
        const local = getLocalData();
        if (remoteSnapshot.exists()) {
          const remote = remoteSnapshot.data();
          if (preferRemoteNextBootstrap || !hasLocalData() || Number(remote.localUpdatedAt) > Number(local._updatedAt || 0)) {
            onRemoteData(remote.state);
            setStatus('Synced · account');
          } else {
            await writeSnapshot(stateRef, firestoreSdk, local);
          }
        } else if (preferRemoteNextBootstrap && getEmptyData) {
          onRemoteData(getEmptyData());
          await writeSnapshot(stateRef, firestoreSdk, getLocalData());
        } else {
          await writeSnapshot(stateRef, firestoreSdk, local);
        }
        preferRemoteNextBootstrap = false;
        bootstrapped = true;
        stopListening?.();
        stopListening = firestoreSdk.onSnapshot(stateRef, snapshot => {
          if (!snapshot.exists()) return;
          const remote = snapshot.data();
          const latestLocal = getLocalData();
          if (Number(remote.localUpdatedAt) > Number(latestLocal._updatedAt || 0)) {
            onRemoteData(remote.state);
            setStatus('Synced · account');
          }
        }, error => {
          console.warn('Firebase listener unavailable; local data remains available.', error);
          setStatus('Local data ready · Firebase reconnecting');
        });
      } else if (writeQueued) {
        await writeSnapshot(stateRef, firestoreSdk, getLocalData());
      }
      if (!writeQueued) setStatus('Synced · account');
      return true;
    } catch (error) {
      console.warn('Firebase unavailable; Setlist will continue using local data.', error);
      setStatus(navigator.onLine ? 'Local data ready · Firebase unavailable' : 'Offline · saved on this device');
      return false;
    } finally {
      connecting = false;
    }
  }

  async function writeSnapshot(stateRef, firestoreSdk, data) {
    if (writing) { writeQueued = true; return; }
    writing = true;
    writeQueued = false;
    try {
      await firestoreSdk.setDoc(stateRef, {
        state: data,
        localUpdatedAt: Number(data._updatedAt) || Date.now(),
        updatedAt: firestoreSdk.serverTimestamp()
      });
      setStatus('Synced · account');
    } catch (error) {
      writeQueued = true;
      throw error;
    } finally {
      writing = false;
      if (writeQueued && navigator.onLine) {
        clearTimeout(writeTimer);
        writeTimer = setTimeout(() => ensureConnection(), 750);
      }
    }
  }

  function saveLocalSnapshot() {
    writeQueued = true;
    if (!navigator.onLine) {
      setStatus('Offline · saved on this device');
      return;
    }
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => ensureConnection(), 500);
  }

  async function getAuthClient() {
    if (!navigator.onLine) throw new Error('Connect to the internet to manage your account.');
    const [appSdk, authSdk] = await loadFirebaseSdk();
    app = app || (appSdk.getApps().length ? appSdk.getApp() : appSdk.initializeApp(FIREBASE_CONFIG));
    auth = auth || authSdk.getAuth(app);
    return authSdk;
  }

  async function createAccount(email, password) {
    const authSdk = await getAuthClient();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) throw new Error('Enter your email address.');
    let result;
    if (auth.currentUser?.isAnonymous) {
      const credential = authSdk.EmailAuthProvider.credential(normalizedEmail, password);
      result = await authSdk.linkWithCredential(auth.currentUser, credential);
    } else if (!auth.currentUser) {
      result = await authSdk.createUserWithEmailAndPassword(auth, normalizedEmail, password);
    } else {
      throw new Error('Log out before creating a different account.');
    }
    onAccount?.({ uid: result.user.uid, email: result.user.email || null, isAnonymous: result.user.isAnonymous });
    await ensureConnection();
    return result.user;
  }

  async function signIn(email, password) {
    const authSdk = await getAuthClient();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) throw new Error('Enter your email address.');
    const previousUserId = auth.currentUser?.uid;
    const result = await authSdk.signInWithEmailAndPassword(auth, normalizedEmail, password);
    if (result.user.uid !== previousUserId) {
      stopListening?.(); stopListening = null; bootstrapped = false; activeUserId = null;
      writeQueued = false; preferRemoteNextBootstrap = true;
    }
    onAccount?.({ uid: result.user.uid, email: result.user.email || null, isAnonymous: result.user.isAnonymous });
    await ensureConnection();
    return result.user;
  }

  async function sendPasswordReset(email) {
    const authSdk = await getAuthClient();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) throw new Error('Enter your email address.');
    await authSdk.sendPasswordResetEmail(auth, normalizedEmail);
    return normalizedEmail;
  }

  async function signOut() {
    const authSdk = await getAuthClient();
    stopListening?.(); stopListening = null; bootstrapped = false; activeUserId = null; writeQueued = false;
    await authSdk.signOut(auth);
    onAccount?.({ uid: null, email: null, isAnonymous: true });
  }

  async function start() { await ensureConnection(); }

  window.addEventListener('online', () => ensureConnection());
  window.addEventListener('offline', () => setStatus('Offline · saved on this device'));

  return {
    start,
    saveLocalSnapshot,
    createAccount,
    signIn,
    sendPasswordReset,
    signOut,
    stop: () => stopListening?.()
  };
}