// A filesystem router's catch-all route module (`[...rest]`), reached as a
// lazy route on /catch-all. Bundlers derive the chunk name from the file
// name, and the default sanitizer only swaps the brackets, so this chunk
// (and the CSS asset named after it) used to build as `_...rest_-<hash>`.
// Hosts and middleware whose traversal guard rejects any URL containing
// `..` (server.js here does) then refused the chunk and the route failed to
// hydrate (#391).
import './catch-all.css';

export default function CatchAllRoute() {
  return <main id="catch-all">CATCH-ALL-PAGE</main>;
}
