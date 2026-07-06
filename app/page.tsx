import Simulator, { SimUser } from '@/components/Simulator';
import { auth0, authConfigured } from '@/auth';

export default async function Home() {
  let user: SimUser | null = null;

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

  return <Simulator user={user} />;
}
