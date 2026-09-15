/**
 * The Vercel function entry point. `vercel.json` rewrites every path to
 * this function; see DEPLOY.md for the deployment recipe.
 */
import { createVercelHandler } from '../src/handler'

export default createVercelHandler()
