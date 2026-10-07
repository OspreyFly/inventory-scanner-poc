Guided Pick AprilTag POC v3

Replace the contents of your existing GitHub Pages scanner repo with the contents of this folder.
Keep the js/ folder intact.

Then:
  git add .
  git commit -m "Switch guided picker to AprilTags"
  git push origin master

On iPhone:
- reopen/refresh the GitHub Pages URL
- confirm heading says "Guided Pick — AprilTag POC"
- choose BIN-A01 / Tag 0
- Start Camera
- point at the printed BIN-A01 tag36h11 marker

This build uses the exact AprilTag JS/WASM assets from the uploaded apriltag-base clone.
Detector settings favor distance/accuracy over frame rate:
- tag36h11 only
- quadDecimate 1.0
- refineEdges true
- 1280px processing width when available

LICENSE and NOTICE from the upstream project are included.
