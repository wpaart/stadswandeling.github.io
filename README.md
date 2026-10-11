# Leuven city walk

A static web app for GitHub Pages. It shows a walking route on OpenStreetMap, follows the visitor's position on a phone, and shows geotagged photos on the map. A small admin page uploads photos and reads their GPS position.

```
index.html        the public map (Leaflet + OpenStreetMap tiles)
admin.html        photo upload page (the "backend")
data/walk.json    the route: title, stops, coordinates, texts
data/photos.json  the photo list (written by admin.html)
photos/           uploaded images
```

## Deploy
1. Create a GitHub repository and push these files to the `main` branch.
2. Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/<repo>/` on your phone and tap the locate button. Geolocation needs HTTPS, which Pages provides.

## Upload photos
1. In GitHub: Settings → Developer settings → Fine-grained tokens. Limit it to this repository with **Contents: Read and write**.
2. Open `admin.html`, enter user, repository, branch and the token, and save.
3. Choose photos. GPS is read from EXIF. For photos without GPS, select the card and click the map, drag the pin, or use your current location.
4. Upload. Images are resized to 1600 px, committed to `photos/`, and listed in `data/photos.json`. The site refreshes after Pages redeploys (about a minute).

Notes:
- iPhones strip location from shared photos unless "Location" is enabled in the share sheet options. Manual placement covers this.
- The token stays in your browser's localStorage and is only sent to api.github.com. Anyone can open `admin.html`, but it does nothing without a token.

## Change the walk
Edit `data/walk.json`. The stop coordinates for Leuven are approximate. Check them on the map and adjust. The route follows footpaths through the public OSM router (routing.openstreetmap.de). If that service is unavailable, the app draws dashed straight lines instead.

## Notes
- The public OSM tile server is fine for small projects. For heavy traffic, use a tile provider or see the OSM tile usage policy.
- "Near you" photos use a configurable radius (30 to 250 m). Moving within that radius of a photo shows a notice and highlights its marker.
