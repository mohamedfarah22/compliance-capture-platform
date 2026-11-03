// The route that opens a draft TTR by id: it warns when another report is in progress, then opens the first step
// that needs input (spec 3.2). Gold's "Start TTR" / "Resume TTR" buttons and the "waiting" notice link here.
export const OPEN_TTR_ROUTE = "/open-ttr/:id";
export const openTtrPath = (id) => `/open-ttr/${id}`;
