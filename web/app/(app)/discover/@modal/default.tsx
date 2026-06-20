// No modal by default. Next.js renders this for the @modal slot whenever the
// current URL doesn't match an intercepted route (i.e. plain /discover), and on
// hard navigation it keeps the slot empty so the full /event/[id] page owns the
// view. Required so the parallel slot has a fallback.
export default function ModalDefault() {
  return null;
}
