import { Router } from 'express';
import { adminAuth, adminAuthChangeOnly, superAdminOnly } from '../auth.js';
import * as a from '../services/admin.js';

export const router = Router();

// no session yet
router.post('/login', async (req, res) => res.json(await a.login(req.body?.email, req.body?.password)));
router.post('/password/change', adminAuthChangeOnly, async (req, res) =>
  res.json(await a.changePassword(req.admin, req.body?.current_password, req.body?.new_password)));

router.use(adminAuth);
router.get('/me', (req, res) => res.json({ operator: { operator_id: req.admin.operator_id, email: req.admin.email, role: req.admin.role } }));

router.get('/buildings', async (_req, res) => res.json(await a.listBuildings()));
router.post('/buildings', async (req, res) => res.status(201).json(await a.createBuilding(req.admin, req.body)));
router.patch('/buildings/:id', async (req, res) => res.json(await a.updateBuilding(req.admin, req.params.id, req.body)));

router.get('/amenities', async (_req, res) => res.json(await a.listAmenities()));
router.post('/amenities', async (req, res) => res.status(201).json(await a.createAmenity(req.admin, req.body?.name)));
router.patch('/amenities/:id', async (req, res) => res.json(await a.renameAmenity(req.admin, req.params.id, req.body?.name)));
router.delete('/amenities/:id', async (req, res) => res.json(await a.deleteAmenity(req.admin, req.params.id)));

router.get('/rooms', async (req, res) => res.json(await a.listRooms(req.query)));
router.post('/rooms', async (req, res) => res.status(201).json(await a.createRoom(req.admin, req.body)));
router.post('/rooms/import', async (req, res) => res.json(await a.importRooms(req.admin, req.body?.rooms)));
router.get('/rooms/:id', async (req, res) => res.json(await a.getRoom(req.params.id)));
router.get('/rooms/:id/deactivation-preview', async (req, res) => res.json(await a.roomDeactivationPreview(req.params.id)));
router.patch('/rooms/:id', async (req, res) => res.json(await a.updateRoom(req.admin, req.params.id, req.body)));

router.get('/closures', async (_req, res) => res.json(await a.listClosures()));
router.post('/closures/preview', async (req, res) => res.json(await a.closurePreview(req.body)));
router.post('/closures', async (req, res) => res.status(201).json(await a.createClosure(req.admin, req.body)));
router.delete('/closures/:id', async (req, res) => res.json(await a.deleteClosure(req.admin, req.params.id)));

router.get('/purposes', async (_req, res) => res.json(await a.listPurposes({ all: true })));
router.post('/purposes', async (req, res) => res.status(201).json(await a.createPurpose(req.admin, req.body)));
router.patch('/purposes/:id', async (req, res) => res.json(await a.updatePurpose(req.admin, req.params.id, req.body)));
router.delete('/purposes/:id', async (req, res) => res.json(await a.deletePurpose(req.admin, req.params.id)));

router.get('/announcements', async (_req, res) => res.json(await a.listAnnouncementsAdmin()));
router.post('/announcements', async (req, res) => res.status(201).json(await a.createAnnouncement(req.admin, req.body)));
router.delete('/announcements/:id', async (req, res) => res.json(await a.deleteAnnouncement(req.admin, req.params.id)));

router.get('/policy', async (_req, res) => res.json(await a.listPolicy()));
router.put('/policy', async (req, res) => res.json(await a.updatePolicy(req.admin, req.body)));

router.get('/audit-log', async (req, res) => res.json(await a.auditLog(req.query)));

// super admin only
router.get('/users', superAdminOnly, async (_req, res) => res.json(await a.listAdmins()));
router.post('/users', superAdminOnly, async (req, res) => res.status(201).json(await a.inviteAdmin(req.admin, req.body)));
router.patch('/users/:id/role', superAdminOnly, async (req, res) => res.json(await a.setAdminRole(req.admin, req.params.id, req.body?.role)));
router.post('/users/:id/revoke', superAdminOnly, async (req, res) => res.json(await a.revokeAdmin(req.admin, req.params.id)));
router.post('/users/:id/reset-password', superAdminOnly, async (req, res) => res.json(await a.resetAdmin(req.admin, req.params.id)));
