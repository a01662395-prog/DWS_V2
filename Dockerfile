FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

WORKDIR /usr/share/nginx/html
COPY index.html manifest.json world.geojson ./
COPY app.js dashboard-global.js db.js pipeline.js pipeline-worker.js ./
COPY estilos.css dashboard-global.css ./
COPY security ./security
COPY vendor ./vendor
COPY muestras ./muestras

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1/index.html && wget -q -O /dev/null http://127.0.0.1/app.js || exit 1
