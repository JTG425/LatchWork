import Simulator, { SimUser } from '@/components/Simulator';
import { auth0, authConfigured } from '@/auth';

export default async function Home() {
  let user: SimUser | null = null;

  if (authConfigured && auth0) {
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

  return (
    <>
      {/* server-rendered intro for search engines and screen readers; the
          simulator itself is a client-side canvas with no indexable text */}
      <section className="sr-only">
        <h1>Latchwork — free online digital logic simulator</h1>
        <p>
          Build and simulate digital logic circuits right in your browser. Wire up
          logic gates (AND, OR, NOT, NAND, NOR, XOR, XNOR), latches, flip-flops,
          shift registers, multi-bit buses, and 7-segment displays; write and
          compile VHDL modules; inspect truth tables, state machine diagrams, and
          timing waveforms; then package your designs into reusable chips and
          share them with the community. No download or sign-up required.
        </p>
      </section>
      <Simulator user={user} authEnabled={authConfigured} />
    </>
  );
}
