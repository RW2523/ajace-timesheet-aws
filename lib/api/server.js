// Server-side API client for server components and route handlers. Talks to
// RDS and S3 directly (no HTTP hop) while exposing the same `.auth` / `.from`
// / `.storage` surface as the browser client.
import { currentUser } from "@/lib/aws/auth";
import { execute } from "@/lib/aws/data";
import { makeBuilder } from "@/lib/aws/builder";
import { signedGetUrl, getObjectBytes, deleteObjects } from "@/lib/aws/storage";

export async function createClient() {
  const user = await currentUser();
  const requireUser = () => {
    if (!user) throw new Error("not authenticated");
    return user;
  };

  return {
    auth: {
      async getUser() {
        return { data: { user: user ? { id: user.id, email: user.email, role: user.role } : null }, error: null };
      },
      // present for API-compat; recovery is token-based now (see /reset)
      async exchangeCodeForSession() { return { error: null }; },
    },

    from: (table) => makeBuilder(table, (st) => execute(requireUser(), st)),

    storage: {
      from() {
        const canReach = (path) => {
          const u = requireUser();
          return String(path).split("/")[0] === u.id || u.role === "admin";
        };
        return {
          async createSignedUrl(path, expiresIn) {
            if (!canReach(path)) return { data: null, error: { message: "forbidden" } };
            return { data: { signedUrl: await signedGetUrl(path, expiresIn) }, error: null };
          },
          async download(path) {
            if (!canReach(path)) return { data: null, error: { message: "forbidden" } };
            const { bytes } = await getObjectBytes(path);
            return { data: new Blob([bytes]), error: null };
          },
          async remove(paths) {
            const u = requireUser();
            const allowed = paths.filter((p) => String(p).split("/")[0] === u.id || u.role === "admin");
            await deleteObjects(allowed);
            return { data: null, error: null };
          },
        };
      },
    },
  };
}
