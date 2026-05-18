import { useSignInWithApple } from '@clerk/expo/apple';
import { useSignIn, useSignUp } from '@clerk/expo/legacy';
import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';

import { AppText, Button, Screen } from '@/components/ui';
import { palette, radius, space } from '@/theme';

type Mode = 'signin' | 'signup' | 'verify';

export default function SignInScreen() {
  const { isLoaded: siLoaded, signIn, setActive: setSiActive } = useSignIn();
  const { isLoaded: suLoaded, signUp, setActive: setSuActive } = useSignUp();
  const { startAppleAuthenticationFlow } = useSignInWithApple();

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

  async function apple() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const { createdSessionId, setActive } = await startAppleAuthenticationFlow();
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
      }
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code !== 'ERR_REQUEST_CANCELED') {
        // Surface the real reason (entitlement / Clerk / network) instead of
        // a generic message.
        setErr(humanError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const field = {
    backgroundColor: palette.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
    color: palette.text,
    fontSize: 16,
    fontWeight: '600' as const,
    padding: space.lg,
    marginBottom: space.md,
  };

  return (
    <Screen scroll>
      <View style={{ paddingTop: space.xxl, paddingBottom: space.xl }}>
        <AppText kind="hero">One<AppText kind="hero" style={{ color: palette.purple }}>Take</AppText></AppText>
        <AppText kind="dim" style={{ marginTop: space.xs }}>
          {mode === 'verify'
            ? `Enter the code we emailed to ${email}.`
            : 'Sign in to back up and restore your Memories.'}
        </AppText>
      </View>

      {mode === 'verify' ? (
        <>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="6-digit code"
            placeholderTextColor={palette.textFaint}
            keyboardType="number-pad"
            style={field}
          />
          <Button label="Verify & continue" icon="checkmark" disabled={busy} onPress={verify} />
          <Pressable onPress={() => setMode('signup')} style={{ marginTop: space.lg }}>
            <AppText kind="dim" style={{ textAlign: 'center' }}>
              Back
            </AppText>
          </Pressable>
        </>
      ) : (
        <>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor={palette.textFaint}
            autoCapitalize="none"
            keyboardType="email-address"
            style={field}
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={palette.textFaint}
            secureTextEntry
            style={field}
          />
          <Button
            label={mode === 'signin' ? 'Sign in' : 'Create account'}
            icon="arrow-forward"
            disabled={busy || email.length < 3 || password.length < 6}
            onPress={mode === 'signin' ? emailSignIn : emailSignUp}
          />
          <Pressable
            onPress={() => {
              setErr(null);
              setMode(mode === 'signin' ? 'signup' : 'signin');
            }}
            style={{ marginVertical: space.lg }}
          >
            <AppText kind="dim" style={{ textAlign: 'center' }}>
              {mode === 'signin'
                ? "No account? Create one"
                : 'Have an account? Sign in'}
            </AppText>
          </Pressable>

          {Platform.OS === 'ios' && (
            <Pressable
              onPress={apple}
              disabled={busy}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: space.sm,
                backgroundColor: '#fff',
                paddingVertical: space.lg,
                borderRadius: radius.pill,
              }}
            >
              <Ionicons name="logo-apple" size={20} color="#000" />
              <AppText kind="body" style={{ color: '#000', fontWeight: '800' }}>
                Continue with Apple
              </AppText>
            </Pressable>
          )}
        </>
      )}

      {err && (
        <AppText
          kind="caption"
          style={{ color: palette.red, marginTop: space.lg, textAlign: 'center' }}
        >
          {err.toUpperCase()}
        </AppText>
      )}
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
