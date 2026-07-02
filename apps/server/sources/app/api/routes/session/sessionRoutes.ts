import { type Fastify } from "../../types";
import { registerSessionCreateOrLoadRoute } from "./registerSessionCreateOrLoadRoute";
import { registerSessionDeleteRoute } from "./registerSessionDeleteRoute";
import { registerSessionArchiveRoutes } from "./registerSessionArchiveRoutes";
import { registerSessionListingRoutes } from "./registerSessionListingRoutes";
import { registerSessionFolderAssignmentRoutes } from "./registerSessionFolderAssignmentRoutes";
import { registerSessionOrganizationRoutes } from "./registerSessionOrganizationRoutes";
import { registerSessionMessageRoutes } from "./registerSessionMessageRoutes";
import { registerSessionPatchRoute } from "./registerSessionPatchRoute";
import { registerSessionReadStateRoutes } from "./registerSessionReadStateRoutes";
import { registerSessionTurnRoutes } from "./registerSessionTurnRoutes";
import { registerSessionEndRoute } from "./registerSessionEndRoute";
import { registerSessionSystemRecordRoutes } from "./registerSessionSystemRecordRoutes";

export function sessionRoutes(app: Fastify) {
    registerSessionListingRoutes(app);
    registerSessionOrganizationRoutes(app);
    registerSessionFolderAssignmentRoutes(app);
    registerSessionCreateOrLoadRoute(app);
    registerSessionArchiveRoutes(app);
    registerSessionMessageRoutes(app);
    registerSessionSystemRecordRoutes(app);
    registerSessionPatchRoute(app);
    registerSessionTurnRoutes(app);
    registerSessionEndRoute(app);
    registerSessionReadStateRoutes(app);
    registerSessionDeleteRoute(app);
}
