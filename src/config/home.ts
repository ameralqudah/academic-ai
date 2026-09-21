/**
 * Where a signed-in person lands: after logging in, after registering, and when
 * they open the bare site or the installed app.
 *
 * It is the chat, because that is where the work starts — opening the product
 * should put the cursor in the composer, not on a page of figures with a button
 * that leads to the composer. The dashboard is still there, one click away in
 * the account menu; it stopped being the front door, not a page.
 *
 * One constant, because the five places that used to spell `/dashboard` out
 * would otherwise drift apart the next time this changes.
 */
export const SIGNED_IN_HOME = '/chat';
