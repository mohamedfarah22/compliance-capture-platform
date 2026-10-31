// Only paths inside this app are followed after sign-in. "//host" and "/\host" are read
// as other sites, so an unchecked ?redirect= would let a phishing link hand a freshly
// signed-in user to any site it names. Whitespace is refused too: browsers strip tabs
// and newlines from URLs, which turns "/\t/host" into "//host".
export const safeRedirect = (value, fallback = "/") => (/^\/(?![/\\])[^\\\s]*$/.test(value ?? "") ? value : fallback);
