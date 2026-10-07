Inventory Scanner POC — iPhone / GitHub Pages

Purpose
-------
This is a static proof of concept. It uses the iPhone camera to read a QR code
and checks whether its value is BIN-A04. No inventory or company data is stored.

GitHub Pages setup
------------------
1. Create a new GitHub repository, e.g. inventory-scanner-poc.
2. Upload index.html from this folder to the repository root.
3. In the repository, open Settings > Pages.
4. Under Build and deployment, choose "Deploy from a branch".
5. Select the main branch and /(root), then Save.
6. GitHub will provide an HTTPS Pages address once deployment finishes.
7. Open that HTTPS address in Safari on your iPhone.
8. Tap Start Camera and allow camera access.
9. Point the camera at a QR code whose contents are exactly: BIN-A04

Expected behavior
-----------------
BIN-A04 -> green border + Correct marker
Anything else -> red border + Wrong marker

Notes
-----
- The QR decoder is jsQR loaded from jsDelivr, so the phone needs internet access.
- This version does not communicate with the Python server.
- It intentionally contains no real inventory/customer/NetSuite data.
- Once scanning is proven, the next version can add tasks and a backend API.
