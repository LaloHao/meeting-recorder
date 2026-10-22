const msg = document.getElementById('msg');

try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  msg.className = 'ok';
  msg.textContent = 'Listo. Ya puedes cerrar esta pestaña y grabar desde el botón de la extensión.';
} catch (err) {
  msg.className = 'err';
  msg.textContent = `No se concedió el permiso (${err.name}). Revísalo en la configuración del sitio de la extensión y recarga esta página.`;
}
