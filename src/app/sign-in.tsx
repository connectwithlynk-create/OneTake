import { useSSO } from '@clerk/expo';
import { useSignIn, useSignUp } from '@clerk/expo/legacy';
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, MonoLabel, Screen, Wordmark } from '@/components/ui';
import { font, palette, space } from '@/theme';

WebBrowser.maybeCompleteAuthSession();

type Mode = 'signin' | 'signup' | 'verify';

export default function SignInScreen() {
  const { isLoaded: siLoaded, signIn, setActive: setSiActive } = useSignIn();
  const { isLoaded: suLoaded, signUp, setActive: setSuActive } = useSignUp();
  const { startSSOFlow } = useSSO();

  useEffect(() => {
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function emailSignIn() {
    if (!siLoaded || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await signIn.create({ identifier: email.trim(), password });
      if (res.status === 'complete') {
        await setSiActive({ session: res.createdSessionId });
      } else {
        setErr('Could not finish sign in.');
      }
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  async function emailSignUp() {
    if (!suLoaded || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await signUp.create({ emailAddress: email.trim(), password });
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setMode('verify');
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!suLoaded || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await signUp.attemptEmailAddressVerification({ code: code.trim() });
      if (res.status === 'complete') {
        await setSuActive({ session: res.createdSessionId });
      } else {
        setErr('Wrong or expired code.');
      }
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: Linking.createURL('/'),
      });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
      }
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code !== 'ERR_REQUEST_CANCELED') setErr(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll pad={false}>
      <View style={s.topRow}>
        <Wordmark size={22} />
        <MonoLabel>BETA · v0.4</MonoLabel>
      </View>

      <View style={{ paddingHorizontal: 22, paddingTop: 50, paddingBottom: 28 }}>
        <Text style={s.hero}>
          Film it.{'\n'}
          Know <Text style={{ color: palette.lime }}>instantly</Text>.{'\n'}
          Ship it.
        </Text>
        <Text style={s.subhero}>
          {mode === 'verify'
            ? `Enter the code we emailed to ${email}.`
            : 'Sign in to back up your memories and restore them on any device.'}
        </Text>
      </View>

      {mode === 'verify' ? (
        <View style={{ paddingHorizontal: 22 }}>
          <MonoLabel style={{ marginBottom: 6 }}>CODE</MonoLabel>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="6-digit code"
            placeholderTextColor={palette.text3}
            keyboardType="number-pad"
            style={s.field}
          />
          <Button
            label="Verify & continue"
            icon="arrow-forward"
            size="lg"
            full
            disabled={busy}
            onPress={verify}
            style={{ marginTop: 22 }}
          />
          <Pressable onPress={() => setMode('signup')} style={{ marginTop: space.lg }}>
            <Text style={s.muted}>Back</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ paddingHorizontal: 22, gap: 12 }}>
          <View>
            <MonoLabel style={{ marginBottom: 6 }}>EMAIL</MonoLabel>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@onetake.app"
              placeholderTextColor={palette.text3}
              autoCapitalize="none"
              keyboardType="email-address"
              style={s.field}
            />
          </View>
          <View>
            <MonoLabel style={{ marginBottom: 6 }}>PASSWORD</MonoLabel>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={palette.text3}
              secureTextEntry
              style={s.field}
            />
          </View>

          <Button
            label={mode === 'signin' ? 'Sign in' : 'Create account'}
            icon="arrow-forward"
            size="lg"
            full
            disabled={busy || email.length < 3 || password.length < 6}
            onPress={mode === 'signin' ? emailSignIn : emailSignUp}
            style={{ marginTop: 10 }}
          />

          <Pressable
            onPress={() => {
              setErr(null);
              setMode(mode === 'signin' ? 'signup' : 'signin');
            }}
            style={{ marginVertical: 8 }}
          >
            <Text style={s.muted}>
              {mode === 'signin' ? 'No account? ' : 'Have an account? '}
              <Text style={{ color: palette.lime, fontFamily: font.bodyBold }}>
                {mode === 'signin' ? 'Create one' : 'Sign in'}
              </Text>
            </Text>
          </Pressable>

          <View style={s.divider}>
            <View style={s.dividerLine} />
            <Text style={s.dividerLabel}>OR</Text>
            <View style={s.dividerLine} />
          </View>

          <Pressable
            onPress={google}
            disabled={busy}
            style={({ pressed }) => [s.google, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name="logo-google" size={18} color="#fff" />
            <Text style={s.googleLabel}>Continue with Google</Text>
          </Pressable>
        </View>
      )}

      {err && (
        <Text
          style={{
            fontFamily: font.monoBold,
            fontSize: 10,
            color: palette.coral,
            letterSpacing: 1.5,
            marginTop: space.lg,
            textAlign: 'center',
          }}
        >
          {err.toUpperCase()}
        </Text>
      )}

      <Text style={s.footer}>
        Clips are local until you sign in. Memories sync across devices.
      </Text>
    </Screen>
  );
}

function humanError(e: unknown): string {
  const clerkMsg = (e as { errors?: { message?: string }[] })?.errors?.[0]
    ?.message;
  const nativeMsg = (e as { message?: string })?.message;
  const code = (e as { code?: string })?.code;
  return clerkMsg || nativeMsg || code || 'Something went wrong. Try again.';
}

const s = StyleSheet.create({
  topRow: {
    paddingHorizontal: 22,
    paddingTop: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  hero: {
    fontFamily: font.displayHeavy,
    fontWeight: '800',
    fontSize: 44,
    color: '#fff',
    letterSpacing: -1.3,
    lineHeight: 42,
  },
  subhero: {
    marginTop: 16,
    fontFamily: font.body,
    fontSize: 14.5,
    color: palette.text2,
    lineHeight: 21,
  },
  field: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: palette.bg1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    color: '#fff',
    fontFamily: font.bodyBold,
    fontSize: 15.5,
    fontWeight: '500',
  },
  muted: {
    textAlign: 'center',
    fontFamily: font.body,
    fontSize: 13,
    color: palette.text3,
  },
  divider: {
    marginVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.08)' },
  dividerLabel: {
    fontFamily: font.mono,
    fontSize: 11,
    letterSpacing: 1,
    color: palette.text3,
  },
  google: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  googleLabel: {
    color: '#fff',
    fontFamily: font.bodyBold,
    fontWeight: '700',
    fontSize: 14.5,
  },
  footer: {
    marginTop: 32,
    paddingHorizontal: 22,
    paddingBottom: 24,
    textAlign: 'center',
    fontFamily: font.body,
    fontSize: 11,
    color: palette.text4,
  },
});
