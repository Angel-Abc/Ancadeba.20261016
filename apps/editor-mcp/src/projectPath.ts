import { z } from 'zod'

/** Workspace-relative project folders, including the explicit workspace root. */
export const workspaceProjectPathSchema = z
  .string()
  .refine(
    (path) =>
      path === '' ||
      path
        .split('/')
        .every(
          (segment) =>
            Boolean(segment) &&
            segment !== '.' &&
            segment !== '..' &&
            !/[<>:"\\|?*]/.test(segment) &&
            !segment.split('').some((character) => character.charCodeAt(0) < 32) &&
            !/[. ]$/.test(segment) &&
            !/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(
              segment,
            ),
        ),
    'Use a workspace-relative project folder with / separators, or empty for the root',
  )
