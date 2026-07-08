import Simulator, { SimUser } from '@/components/Simulator';
import { auth0, authConfigured, authEnv } from '@/auth';
import type { AuthPublicConfig } from '@/lib/auth-embedded';

export default async function Home() {
  let user: SimUser | null = null;

  /* Public Auth0 values for the embedded sign-in dialog (the client id
     is public by design — it appears in every /authorize URL). */
  const auth: AuthPublicConfig | null = authConfigured
    ? {
        domain: authEnv.domain!,
        clientId: authEnv.clientId!,
        realm: authEnv.connection,
      }
    : null;

  if (authConfigured) {
    try {
      const session = await auth0.getSession();
      if (session?.user) {
        user = {
          id: session.user.sub,
          name: session.user.name,
          email: session.user.email,
        };
      }
    } catch {
      user = null;
    }
  }

  return <Simulator user={user} auth={auth} />;
}
