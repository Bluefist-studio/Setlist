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
  let connectionPromise;
  let writing = false;
  let writeQueued = false;
  let writeTimer;
  let stopListening;

  const setStatus = message => onStatus(message);

  async function ensureConnection(requiredUserId = null) {
    if (!navigator.onLine) {
      setStatus('Offline · saved on this device');
      return false;
    }
    if (connectionPromise) {
      const pendingConnection = connectionPromise;
      const connected = await pendingConnection;
      if (requiredUserId && auth?.currentUser?.uid === requiredUserId && activeUserId !== requiredUserId) {
        if (connectionPromise === pendingConnection) connectionPromise = null;
        return ensureConnection(requiredUserId);
      }
      return connected;
    }
    const pendingConnection = connect();
    connectionPromise = pendingConnection;
    try {
      return await pendingConnection;
    } finally {
      if (connectionPromise === pendingConnection) connectionPromise = null;
    }
  }

  async function connect() {
    setStatus('Connecting to Firebase…');
    try {
      const [appSdk, authSdk, firestoreSdk] = await loadFirebaseSdk();
      app = app || (appSdk.getApps().length ? appSdk.getApp() : appSdk.initializeApp(FIREBASE_CONFIG));
      auth = auth || authSdk.getAuth(app);
      database = database || firestoreSdk.getFirestore(app);
      await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
      await auth.authStateReady();
      if (!auth.currentUser) {
        onAccount?.({ uid: null, email: null, isAnonymous: false });
        setStatus('Local data ready · create an account or log in to sync');
        return false;
      }

      const userId = auth.currentUser.uid;
      const emailVerified = auth.currentUser.isAnonymous || auth.currentUser.emailVerified;
      onAccount?.({ uid: userId, email: auth.currentUser.email || null, isAnonymous: auth.currentUser.isAnonymous, emailVerified });
      if (!emailVerified) {
        setStatus('Email verification required · saved on this device');
        return false;
      }
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
        const localBelongsToUser = !local?._accountUid || local._accountUid === userId;
        if (remoteSnapshot.exists()) {
          const remote = remoteSnapshot.data();
          if (!isValidState(remote.state)) throw new Error('Saved account data has an unexpected format.');
          if (preferRemoteNextBootstrap || !localBelongsToUser || !hasLocalData() || Number(remote.localUpdatedAt) > Number(local._updatedAt || 0)) {
            onRemoteData(remote.state);
            setStatus('Synced · account');
          } else {
            local._accountUid = userId;
            await writeSnapshot(stateRef, firestoreSdk, local);
          }
        } else if ((preferRemoteNextBootstrap || !localBelongsToUser) && getEmptyData) {
          onRemoteData(getEmptyData());
          const empty = getLocalData();
          empty._accountUid = userId;
          await writeSnapshot(stateRef, firestoreSdk, empty);
        } else {
          local._accountUid = userId;
          await writeSnapshot(stateRef, firestoreSdk, local);
        }
        const currentLocal = getLocalData();
        if (currentLocal) currentLocal._accountUid = userId;
        preferRemoteNextBootstrap = false;
        bootstrapped = true;
        stopListening?.();
        stopListening = firestoreSdk.onSnapshot(stateRef, snapshot => {
          if (!snapshot.exists()) return;
          const remote = snapshot.data();
          if (!isValidState(remote.state)) {
            setStatus('Saved account data could not be read · check Firebase data format');
            return;
          }
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
      setStatus(navigator.onLine ? `Account data unavailable · ${error.message || 'Firebase error'}` : 'Offline · saved on this device');
      return false;
    }
  }

  function isValidState(value) {
    return value && typeof value === 'object' && value.user && typeof value.user === 'object'
      && Array.isArray(value.workouts) && Array.isArray(value.history);
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
    await authSdk.sendEmailVerification(result.user);
    onAccount?.({ uid: result.user.uid, email: result.user.email || null, isAnonymous: result.user.isAnonymous, emailVerified: false });
    setStatus('Verification email sent · saved on this device until verified');
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
    onAccount?.({ uid: result.user.uid, email: result.user.email || null, isAnonymous: result.user.isAnonymous, emailVerified: result.user.isAnonymous || result.user.emailVerified });
    if (!result.user.isAnonymous && !result.user.emailVerified) return result.user;
    const connected = await ensureConnection(result.user.uid);
    if (!connected || !bootstrapped || activeUserId !== result.user.uid) {
      throw new Error('Your account was verified, but its saved data could not be loaded. Check your connection and Firestore rules, then try again.');
    }
    return result.user;
  }

  async function sendPasswordReset(email) {
    const authSdk = await getAuthClient();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) throw new Error('Enter your email address.');
    await authSdk.sendPasswordResetEmail(auth, normalizedEmail);
    return normalizedEmail;
  }

  async function resendVerification() {
    const authSdk = await getAuthClient();
    if (!auth.currentUser || auth.currentUser.isAnonymous || auth.currentUser.emailVerified) return false;
    await authSdk.sendEmailVerification(auth.currentUser);
    setStatus('Verification email sent · saved on this device until verified');
    return true;
  }

  async function refreshAccount() {
    const authSdk = await getAuthClient();
    if (!auth.currentUser) return false;
    await auth.currentUser.reload();
    const user = auth.currentUser;
    const emailVerified = user.isAnonymous || user.emailVerified;
    onAccount?.({ uid: user.uid, email: user.email || null, isAnonymous: user.isAnonymous, emailVerified });
    if (!emailVerified) return false;
    bootstrapped = false;
    writeQueued = false;
    return ensureConnection(user.uid);
  }

  async function signOut() {
    const authSdk = await getAuthClient();
    stopListening?.(); stopListening = null; bootstrapped = false; activeUserId = null; writeQueued = false;
    await authSdk.signOut(auth);
    onAccount?.({ uid: null, email: null, isAnonymous: true, emailVerified: false });
  }

  async function start() { await ensureConnection(); }

  window.addEventListener('online', () => ensureConnection());
  window.addEventListener('offline', () => setStatus('Offline · saved on this device'));

  return {
    start,
    saveLocalSnapshot,
    createAccount,
    signIn,
    resendVerification,
    refreshAccount,
    sendPasswordReset,
    signOut,
    stop: () => stopListening?.()
  };
}