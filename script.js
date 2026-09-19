// Dynamic Year
document.getElementById('year').textContent = new Date().getFullYear();

// Intersection Observer for Fade-in Animation
const observerOptions = {
    root: null,
    rootMargin: '0px',
    threshold: 0.1
};

const observer = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target); // Only animate once
        }
    });
}, observerOptions);

document.querySelectorAll('.fade-in-section').forEach(section => {
    observer.observe(section);
});

// Mobile Nav Toggle
const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');

if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
        const isOpen = navLinks.classList.toggle('is-open');
        navToggle.classList.toggle('is-active', isOpen);
        navToggle.setAttribute('aria-expanded', isOpen);
    });

    navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            navLinks.classList.remove('is-open');
            navToggle.classList.remove('is-active');
            navToggle.setAttribute('aria-expanded', 'false');
        });
    });
}
