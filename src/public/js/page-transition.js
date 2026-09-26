function navigateWithFade(url) {
  document.body.classList.add('page-fade-out');
  setTimeout(() => { location.href = url; }, 150);
}