import Simulator, { SimUser } from '@/components/Simulator';
import { auth0, authConfigured } from '@/auth';
import type { AuthPublicConfig } from '@/lib/auth-embedded';

export default async function Home() {
  let user: SimUser | null = null;

  /* Public Auth0 values for the embedded sign-in dialog (the client id
     is public by design — it appears in every /authorize URL). */
  const auth: AuthPublicConfig | null = authConfigured
    ? {
        domain: process.env.AUTH_AUTH0_DOMAIN!,
        clientId: process.env.AUTH_AUTH0_CLIENT_ID!,
        realm: process.env.AUTH_AUTH0_CONNECTION || 'Username-Password-Authentication',
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
